import { db, logEvent } from "../db";
import { pickFreeName, crossProviderOverlaps, OVERLAP_HINT } from "../accounts";
import type { OverlapWarning } from "../accounts";
import { convert, round2 } from "../fx";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "../categories";
import { merchantCategoryMap, normMerchant } from "../merchantMemory";
import type { BankConnection, User } from "../generated/prisma/client";
import { mccCategory } from "../zenmoney/mapping";
import { RowPricer } from "../zenmoney/sync";
import { ebTransactions, ebBalances, ebDerivedId, EbAuthError } from "./client";
import type { EbTransaction, EbAccount } from "./client";

const EXT_PREFIX = "eb:";
const MAX_PAGES_PER_ACCOUNT = 30; // per account per sync, shared by the incremental and gap windows
const CURSOR_OVERLAP_DAYS = 5; // re-fetch a few days back; dedup absorbs the overlap
const FX_PAIR_TOLERANCE = 0.02; // cross-currency transfer pairing: FX spread allowance

// Same rule as ZenMoney sync: a row edited after import belongs to the user,
// and sync writes pin updatedAt to createdAt so they never read as edits.
const TOUCH_GRACE_MS = 2_000;
const userTouched = (tx: { createdAt: Date; updatedAt: Date }) =>
  tx.updatedAt.getTime() - tx.createdAt.getTime() > TOUCH_GRACE_MS;

interface AccountMapEntry {
  accountId: string;
  enabled: boolean;
  cursor?: string; // last synced booking_date (YYYY-MM-DD)
  // History the page cap cut off, still to fetch (dates inclusive).
  gap?: { from: string; to: string };
  // EB account uids live only as long as their session, while the map is keyed
  // by the CURRENT session's uid. key = the uid at first link: transaction ids
  // stay eb:<key>:<ref> across consent renewals. Absent = the map key itself.
  key?: string;
  identity?: string; // identification_hash|CURRENCY: the same bank account in any session
}

export interface EbConnectionMeta {
  state?: string; // pending auth nonce, cleared by the callback
  aspsp?: { name: string; country: string };
  validUntil?: string;
  accountsInfo?: EbAccount[];
}

export interface SyncOptions {
  dryRun?: boolean;
  monthsBack?: number;
}

interface NewRow {
  accountUid: string;
  accountId: string;
  externalId: string;
  t: EbTransaction;
  amount: number;
  currency: string;
  date: string;
  isDebit: boolean;
}

const rowDate = (t: EbTransaction): string | undefined =>
  t.booking_date ?? t.transaction_date ?? t.value_date ?? undefined;

const shiftDays = (date: string, days: number) =>
  new Date(new Date(date).getTime() + days * 86_400_000).toISOString().slice(0, 10);

// Cross-session identity = EB's identification_hash plus the currency: banks
// can expose several sub-accounts (currency pockets, cards) behind one IBAN.
// The account row carries it too (externalId "<key>#<identity>"), so it
// survives a disconnect, which deletes the connection row and its map. Legacy
// rows hold the bare key; the identity is appended on their next sync.
const ID_SEP = "#";
const keyOf = (externalId: string | null) => externalId?.split(ID_SEP)[0] || undefined;
const identityOf = (externalId: string | null) =>
  externalId?.includes(ID_SEP) ? externalId.slice(externalId.indexOf(ID_SEP) + 1) : undefined;

export async function syncEnableBanking(userId: string, opts: SyncOptions = {}) {
  const connection = await db.bankConnection.findUnique({
    where: { userId_provider: { userId, provider: "enablebanking" } },
  });
  if (!connection) {
    throw new Error("No bank is connected. Use connect_bank with action=start first.");
  }
  if (connection.status === "pending" || !connection.tokenEnc) {
    throw new Error(
      "Bank authorization is not finished. Ask the user to open the authorization link from connect_bank action=start and approve access at their bank, then sync again."
    );
  }
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("Account not found.");
  const meta = (connection.meta ?? {}) as EbConnectionMeta;

  // A consent past its validUntil cannot work: flip to the reconnect state
  // without spending one of the bank's few daily accesses on a certain 401.
  if (meta.validUntil && Date.parse(meta.validUntil) <= Date.now()) {
    const message = `Bank consent expired on ${meta.validUntil.slice(0, 10)}. Reconnect with connect_bank action=start to resume syncing.`;
    await db.bankConnection.update({ where: { id: connection.id }, data: { status: "error", lastError: message } });
    throw new EbAuthError(message);
  }

  try {
    return await runSync(connection, user, meta, opts);
  } catch (e) {
    // Only an ended consent is the user's to fix: status "error" until they
    // reconnect. Our own credentials failing, rate limits, 5xx, FX outages,
    // bugs: record lastError and stay "active"; autosync waits 6 h before the
    // next unattended try (PSD2 allows few a day), a manual sync_bank always runs.
    const message = e instanceof Error ? e.message : String(e);
    await db.bankConnection
      .update({
        where: { id: connection.id },
        data: { ...(e instanceof EbAuthError ? { status: "error" } : {}), lastError: message.slice(0, 500) },
      })
      .catch(() => {});
    throw e;
  }
}

async function runSync(connection: BankConnection, user: User, meta: EbConnectionMeta, opts: SyncOptions) {
  const userId = user.id;
  const dryRun = opts.dryRun === true;
  const accountsInfo = (meta.accountsInfo ?? []).filter((a): a is EbAccount & { uid: string } => !!a.uid);
  const sessionUids = new Set(accountsInfo.map((a) => a.uid));
  // Entries from an older session stay in the map (re-keyed if their account
  // comes back) but are never fetched: their uids died with that session.
  const live = (uid: string) => sessionUids.size === 0 || sessionUids.has(uid);

  // --- Accounts: one of ours per bank account from the consented session ---
  const accountMap = { ...((connection.accountMap ?? {}) as unknown as Record<string, AccountMapEntry>) };
  let accountsCreated = 0;
  let accountsRelinked = 0;
  const ourAccounts = await db.account.findMany({ where: { userId } });
  const namesTaken = new Set(ourAccounts.map((a) => a.name.toLowerCase()));
  // Matching by identity only where it is unambiguous on both sides: a shared
  // identity falls back to uid-only matching (a new account, as before) rather
  // than routing one sub-account's rows into another.
  const identityOfAcc = (a: EbAccount) =>
    a.identification_hash ? `${a.identification_hash}|${a.currency?.toUpperCase() ?? ""}` : undefined;
  const identitySeen = new Map<string, number>();
  for (const a of accountsInfo) {
    const id = identityOfAcc(a);
    if (id) identitySeen.set(id, (identitySeen.get(id) ?? 0) + 1);
  }
  const sole = <T>(hits: T[]) => (hits.length === 1 ? hits[0] : undefined);
  const staleUid = (match: (e: AccountMapEntry) => boolean) =>
    sole(Object.keys(accountMap).filter((u) => !sessionUids.has(u) && match(accountMap[u]!)));

  let mapDirty = false;
  const overlapWarnings: OverlapWarning[] = [];
  for (const acc of accountsInfo) {
    const rawIdentity = identityOfAcc(acc);
    const identity = rawIdentity && identitySeen.get(rawIdentity) === 1 ? rawIdentity : undefined;
    const current = accountMap[acc.uid];
    if (current) {
      if (identity && current.identity !== identity) {
        current.identity = identity;
        mapDirty = true;
      }
      continue;
    }
    // Consent renewal: the same bank account under a new uid. Re-key its old
    // entry; enabled flag, cursor, gap and original key carry over.
    let oldUid = identity ? staleUid((e) => e.identity === identity) : undefined;
    let known: (typeof ourAccounts)[number] | undefined;
    if (!oldUid) {
      // An account this bank account fed before: an interrupted first sync
      // (created, map never saved) or a disconnect + reconnect (map deleted
      // with the connection row, identity kept on the account row).
      const liveIds = new Set(
        Object.entries(accountMap)
          .filter(([u]) => sessionUids.has(u))
          .map(([, e]) => e.accountId)
      );
      const ours = ourAccounts.filter((a) => a.provider === "enablebanking" && !liveIds.has(a.id));
      known =
        ours.find((a) => keyOf(a.externalId) === acc.uid) ??
        (identity ? sole(ours.filter((a) => identityOf(a.externalId) === identity)) : undefined);
      if (known) oldUid = staleUid((e) => e.accountId === known!.id);
    }
    if (oldUid) {
      const old = accountMap[oldUid]!;
      delete accountMap[oldUid];
      accountMap[acc.uid] = { ...old, key: old.key ?? oldUid, ...(identity ? { identity } : {}) };
      accountsRelinked++;
      mapDirty = true;
      continue;
    }
    if (known) {
      const key = keyOf(known.externalId);
      accountMap[acc.uid] = {
        accountId: known.id,
        enabled: true,
        ...(key && key !== acc.uid ? { key } : {}),
        ...(identity ? { identity } : {}),
      };
      if (key !== acc.uid) accountsRelinked++;
      mapDirty = true;
      continue;
    }
    const iban = acc.account_id?.iban ?? undefined;
    const baseName =
      acc.name ?? acc.product ?? (iban ? `Account ...${iban.slice(-4)}` : `${meta.aspsp?.name ?? "Bank"} account`);
    const currency = acc.currency?.toUpperCase();
    const bank = meta.aspsp?.name ?? "bank";
    const name = pickFreeName(baseName, namesTaken, currency ? [currency, `${bank} ${currency}`] : [bank]);
    let created;
    try {
      created = await db.account.create({
        data: {
          userId,
          name,
          type: "bank",
          provider: "enablebanking",
          externalId: identity ? `${acc.uid}${ID_SEP}${identity}` : acc.uid,
          currency,
        },
      });
    } catch {
      throw new Error(
        `Cannot create account "${name}" for bank sub-account ${iban ?? acc.uid}: the name is already taken. ` +
          `Rename or delete the clashing account (update_account / delete_account), then sync again.`
      );
    }
    for (const o of crossProviderOverlaps(created, ourAccounts)) {
      overlapWarnings.push({
        created_account: name,
        existing_account: o.name,
        existing_provider: o.provider,
        hint: OVERLAP_HINT,
      });
    }
    namesTaken.add(name.toLowerCase());
    ourAccounts.push(created);
    accountMap[acc.uid] = { accountId: created.id, enabled: true, ...(identity ? { identity } : {}) };
    mapDirty = true;
    accountsCreated++;
  }
  // Persist the map right away: a failure later in the sync must not orphan
  // the accounts just created, re-attached or re-keyed.
  if (mapDirty) {
    await db.bankConnection.update({ where: { id: connection.id }, data: { accountMap: accountMap as object } });
  }
  // Stamp the identity on account rows that predate it (one write each, once).
  for (const [uid, entry] of Object.entries(accountMap)) {
    if (!entry.identity || !sessionUids.has(uid)) continue;
    const acc = ourAccounts.find((a) => a.id === entry.accountId);
    if (!acc || acc.provider !== "enablebanking" || identityOf(acc.externalId) === entry.identity) continue;
    const externalId = `${keyOf(acc.externalId) ?? entry.key ?? uid}${ID_SEP}${entry.identity}`;
    await db.account.update({ where: { id: acc.id }, data: { externalId } });
    acc.externalId = externalId;
  }

  const liveEntries = Object.entries(accountMap).filter(([uid]) => live(uid));
  const firstSync = liveEntries.every(([, m]) => !m.cursor);
  const monthsBack = opts.monthsBack ?? 3;
  const historyFrom = new Date(Date.now() - monthsBack * 30.44 * 86_400_000).toISOString().slice(0, 10);

  // --- Pull pages per enabled account, collect candidate rows ---
  const candidates: NewRow[] = [];
  let pendingSkipped = 0;
  let truncated = false;
  const today = new Date().toISOString().slice(0, 10);

  for (const [uid, entry] of liveEntries) {
    if (!entry.enabled) continue;
    const key = entry.key ?? uid;
    let pagesLeft = MAX_PAGES_PER_ACCOUNT;
    let newest = entry.cursor ?? "";

    // One window = one paged fetch. Repeats of an identical row WITHIN a
    // window are numbered id, id:2, id:3 (a bank without entry_reference books
    // two equal coffees as two equal rows); the first keeps the plain id, so
    // rows stored before the numbering keep theirs.
    const fetchWindow = async (from: string, to?: string) => {
      const repeats = new Map<string, number>();
      let min = "";
      let max = "";
      let continuationKey: string | undefined;
      do {
        if (pagesLeft === 0) return { cut: true, min, max };
        pagesLeft--;
        const data = await ebTransactions(uid, { dateFrom: from, dateTo: to, continuationKey });
        for (const t of data.transactions ?? []) {
          const date = rowDate(t);
          if (date && (!min || date < min)) min = date;
          if (date && date > max) max = date;
          if (t.status !== "BOOK") {
            pendingSkipped++;
            continue; // pending rows change reference when booked; import booked only
          }
          if (!date) continue;
          const amount = round2(Math.abs(Number(t.transaction_amount.amount)));
          if (!Number.isFinite(amount) || amount === 0) continue;
          if (date > newest) newest = date;
          let ref = t.entry_reference || "";
          if (!ref) {
            const derived = ebDerivedId(key, t);
            const n = (repeats.get(derived) ?? 0) + 1;
            repeats.set(derived, n);
            ref = n === 1 ? derived : `${derived}:${n}`;
          }
          candidates.push({
            accountUid: uid,
            accountId: entry.accountId,
            externalId: `${EXT_PREFIX}${key}:${ref}`,
            t,
            amount,
            currency: t.transaction_amount.currency.toUpperCase(),
            date,
            isDebit: t.credit_debit_indicator === "DBIT",
          });
        }
        continuationKey = data.continuation_key ?? undefined;
      } while (continuationKey);
      return { cut: false, min, max };
    };

    // Incremental window first (fresh rows matter most), then any history gap
    // an earlier capped fetch left, with the pages that remain.
    const from = entry.cursor ? shiftDays(entry.cursor, -CURSOR_OVERLAP_DAYS) : historyFrom;
    const inc = await fetchWindow(from);
    let gap = entry.gap;
    if (inc.cut) {
      truncated = true;
      // Newest-first paging stopped above `from`: the older part becomes a gap
      // fetched with date_to (its oldest day again, it may be split). Oldest-
      // first paging needs none: the cursor resumes after the newest row seen.
      if (inc.min && inc.min > from) {
        gap = gap
          ? { from: gap.from < from ? gap.from : from, to: gap.to > inc.min ? gap.to : inc.min }
          : { from, to: inc.min };
      }
    }
    if (gap && pagesLeft > 0) {
      const g = await fetchWindow(gap.from, gap.to);
      if (!g.cut) {
        gap = undefined;
      } else {
        truncated = true;
        // Keep the unfetched end: below the oldest row seen (newest-first) or
        // above the newest (oldest-first). A window that did not shrink is one
        // day holding more than the page budget: give it up rather than loop.
        const rest =
          g.min && g.min > gap.from
            ? { from: gap.from, to: g.min }
            : g.max && g.max < gap.to
              ? { from: g.max, to: gap.to }
              : undefined;
        gap = rest && (rest.from !== gap.from || rest.to !== gap.to) ? rest : undefined;
      }
    }
    if (!dryRun) {
      if (newest) entry.cursor = newest > today ? today : newest;
      if (gap) entry.gap = gap;
      else delete entry.gap;
    }
  }

  // The same id twice in one sync (overlapping windows, or a bank reusing an
  // entry_reference) is one row: keep the first, never insert twice.
  const seenIds = new Set<string>();
  const unique = candidates.filter((r) => !seenIds.has(r.externalId) && !!seenIds.add(r.externalId));

  // --- Drop rows already imported (by external id, either side of a transfer) ---
  const fresh: NewRow[] = [];
  let updated = 0;
  for (const row of unique) {
    const existing = await db.transaction.findFirst({
      where: { userId, OR: [{ externalId: row.externalId }, { counterExternalId: row.externalId }] },
    });
    if (!existing) {
      fresh.push(row);
      continue;
    }
    if (existing.counterExternalId === row.externalId) continue; // credit side of a merged transfer
    if (existing.type === "transfer") continue; // merged/paired transfer row: legs carry no merchant to refresh
    if (userTouched(existing)) continue;
    const merchant = (row.isDebit ? row.t.creditor?.name : row.t.debtor?.name) ?? null;
    const note = (row.t.remittance_information ?? []).join(" ").trim() || null;
    if ((existing.merchant ?? null) === merchant && (existing.note ?? null) === note) continue;
    if (!dryRun) {
      await db.transaction.update({
        where: { id: existing.id },
        data: { merchant, note, updatedAt: existing.createdAt }, // a sync write, not a user edit
      });
    }
    updated++;
  }

  // --- Transfer pairing: debit on one account + equal credit on another, same
  // day, unique match on both sides -> one transfer row instead of expense+income.
  const pairedCredit = new Map<NewRow, NewRow>(); // debit -> credit
  const takenCredits = new Set<NewRow>();
  for (const d of fresh) {
    if (!d.isDebit) continue;
    const matches = fresh.filter(
      (c) =>
        !c.isDebit &&
        !takenCredits.has(c) &&
        c.accountUid !== d.accountUid &&
        c.currency === d.currency &&
        c.date === d.date &&
        Math.abs(c.amount - d.amount) <= 0.009
    );
    if (matches.length === 1) {
      pairedCredit.set(d, matches[0]!);
      takenCredits.add(matches[0]!);
    }
  }

  // --- Cross-currency pass: an FX exchange between own accounts books a debit
  // in one currency and a credit in another. Amounts must agree through that
  // day's FX rate within FX_PAIR_TOLERANCE (banks apply their own spread), and
  // the pair must be unique in BOTH directions - anything ambiguous stays two
  // plain rows the user can still glue with update_transaction.
  const fxDebits = fresh.filter((d) => d.isDebit && !pairedCredit.has(d));
  const fxCredits = fresh.filter((c) => !c.isDebit && !takenCredits.has(c));
  const fxCandidates = new Map<NewRow, NewRow[]>(); // debit -> matching credits
  const creditHits = new Map<NewRow, number>(); // credit -> matching debit count
  for (const d of fxDebits) {
    for (const c of fxCredits) {
      if (c.accountUid === d.accountUid || c.currency === d.currency || c.date !== d.date) continue;
      let expected: number;
      try {
        expected = (await convert(d.amount, d.currency, c.currency, new Date(`${d.date}T00:00:00.000Z`))).converted;
      } catch {
        continue; // unknown currency or FX sources down: no pairing, plain rows
      }
      if (Math.abs(expected - c.amount) > expected * FX_PAIR_TOLERANCE) continue;
      fxCandidates.set(d, [...(fxCandidates.get(d) ?? []), c]);
      creditHits.set(c, (creditHits.get(c) ?? 0) + 1);
    }
  }
  for (const [d, cands] of fxCandidates) {
    if (cands.length !== 1) continue;
    const c = cands[0]!;
    if (creditHits.get(c) !== 1 || takenCredits.has(c)) continue;
    pairedCredit.set(d, c);
    takenCredits.add(c);
  }

  // --- Import ---
  let imported = 0;
  let transfers = 0;
  let merged = 0;
  const pricer = new RowPricer(user.baseCurrency);

  // User's remembered per-merchant categories beat MCC guessing.
  const memory = await merchantCategoryMap(
    userId,
    fresh.map((r) => (r.isDebit ? r.t.creditor?.name : r.t.debtor?.name) ?? undefined)
  );

  for (const row of fresh) {
    if (takenCredits.has(row)) continue; // consumed as the credit side of a transfer
    const occurredAt = new Date(`${row.date}T00:00:00.000Z`);
    const homeAcc = ourAccounts.find((a) => a.id === row.accountId);
    const note = (row.t.remittance_information ?? []).join(" ").trim() || undefined;

    const credit = pairedCredit.get(row);
    if (credit) {
      if (!dryRun) {
        // No rate: both legs wait (counted in skipped_unpriced), a re-sync pairs them again.
        const fx = await pricer.price(row.amount, row.currency, occurredAt);
        if (!fx) continue;
        await db.transaction.create({
          data: {
            userId,
            accountId: row.accountId,
            type: "transfer",
            amount: row.amount,
            currency: row.currency,
            amountBase: fx.converted,
            fxRate: fx.rate,
            note,
            occurredAt,
            source: "bank",
            externalId: row.externalId,
            counterExternalId: credit.externalId,
            entity: homeAcc?.entity ?? "personal",
            counterAccountId: credit.accountId,
            counterAmount: credit.amount,
            counterCurrency: credit.currency,
          },
        });
      }
      transfers++;
      continue;
    }

    const type = row.isDebit ? ("expense" as const) : ("income" as const);
    const merchant = (row.isDebit ? row.t.creditor?.name : row.t.debtor?.name) ?? undefined;
    const mcc = row.t.merchant_category_code ? Number(row.t.merchant_category_code) : undefined;
    const validForType = row.isDebit ? EXPENSE_CATEGORIES : INCOME_CATEGORIES;
    const rememberedRaw = merchant ? memory.get(normMerchant(merchant)) : undefined;
    const remembered =
      rememberedRaw && (validForType as readonly string[]).includes(rememberedRaw) ? rememberedRaw : undefined;
    const category = remembered ?? (row.isDebit && mcc ? (mccCategory(mcc) ?? "other") : "other");

    // Manual/receipt twin the user hand-logged before the bank confirmed it.
    // updatedAt is not pinned: the merged row stays the user's own record.
    const windowStart = new Date(occurredAt.getTime() - 2 * 86_400_000);
    const windowEnd = new Date(occurredAt.getTime() + 2 * 86_400_000);
    const twin = (
      await db.transaction.findMany({
        where: {
          userId,
          type,
          currency: row.currency,
          source: { in: ["manual", "receipt"] },
          occurredAt: { gte: windowStart, lte: windowEnd },
        },
      })
    ).find((c) => Math.abs(Number(c.amount) - row.amount) <= 0.009);
    if (twin) {
      if (!dryRun) {
        await db.transaction.update({
          where: { id: twin.id },
          data: { accountId: row.accountId, externalId: row.externalId, source: "bank" },
        });
      }
      merged++;
      continue;
    }

    if (!dryRun) {
      const fx = await pricer.price(row.amount, row.currency, occurredAt);
      if (!fx) continue; // no rate: counted in skipped_unpriced
      await db.transaction.create({
        data: {
          userId,
          accountId: row.accountId,
          type,
          amount: row.amount,
          currency: row.currency,
          amountBase: fx.converted,
          fxRate: fx.rate,
          categoryKey: category,
          merchant,
          note,
          occurredAt,
          source: "bank",
          externalId: row.externalId,
          entity: homeAcc?.entity ?? "personal",
        },
      });
    }
    imported++;
  }

  // --- Balances: authoritative snapshots for every synced account ---
  let balancesAnchored = 0;
  if (!dryRun) {
    const asOf = new Date(
      `${new Intl.DateTimeFormat("en-CA", { timeZone: user.timezone }).format(new Date())}T00:00:00.000Z`
    );
    for (const [uid, entry] of liveEntries) {
      if (!entry.enabled) continue;
      try {
        const balances = await ebBalances(uid);
        const best = balances.find((b) => b.balance_type === "CLBD") ?? balances[0];
        if (!best) continue;
        const amount = round2(Number(best.balance_amount.amount));
        if (!Number.isFinite(amount)) continue;
        await db.balanceSnapshot.upsert({
          where: { accountId_asOf: { accountId: entry.accountId, asOf } },
          update: { amount, currency: best.balance_amount.currency.toUpperCase() },
          create: {
            userId,
            accountId: entry.accountId,
            amount,
            currency: best.balance_amount.currency.toUpperCase(),
            asOf,
          },
        });
        balancesAnchored++;
      } catch (e) {
        if (e instanceof EbAuthError) throw e;
        // Balance endpoint failing must not lose an otherwise good sync.
      }
    }
  }

  if (!dryRun) {
    await db.bankConnection.update({
      where: { id: connection.id },
      data: {
        status: "active",
        lastError: pricer.lastError(),
        lastSyncAt: new Date(),
        accountMap: accountMap as object,
      },
    });
  }
  logEvent("bank_imported", userId, { imported: imported + transfers, provider: "enablebanking", dry_run: dryRun });

  return {
    ...(dryRun ? { dry_run: true } : {}),
    bank: meta.aspsp?.name,
    first_sync: firstSync,
    ...(firstSync ? { history_from: historyFrom } : {}),
    accounts_created: accountsCreated,
    ...(accountsRelinked ? { accounts_relinked: accountsRelinked } : {}),
    ...(overlapWarnings.length ? { overlap_warnings: overlapWarnings } : {}),
    accounts_synced: liveEntries.filter(([, m]) => m.enabled).length,
    imported,
    transfers,
    updated,
    manual_twins_merged: merged,
    ...(pendingSkipped ? { pending_rows_skipped: pendingSkipped } : {}),
    ...(truncated
      ? {
          truncated: true,
          truncated_hint:
            "The bank returned more pages than one sync fetches. The rest is resumed on the next sync (automatic daily, or run sync_bank again).",
        }
      : {}),
    ...(pricer.unpriced.size
      ? {
          skipped_unpriced: Object.fromEntries(pricer.unpriced),
          skipped_unpriced_hint:
            "Not imported: no exchange-rate source covers these currencies yet. Tell the user; a sync after a reconnect re-reads the history window and imports them once covered.",
        }
      : {}),
    balances_anchored: balancesAnchored,
    consent_valid_until: meta.validUntil,
    ...(imported > 0
      ? {
          hint: "Bank rows without a recognizable MCC or remembered merchant land in category 'other'. Review with get_transactions (category=other) and fix via update_transaction - fixes are remembered per merchant for future syncs.",
        }
      : {}),
  };
}
