import { db, logEvent } from "../db";
import { convert, round2 } from "../fx";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "../categories";
import { merchantCategoryMap, normMerchant } from "../merchantMemory";
import { mccCategory } from "../zenmoney/mapping";
import { ebTransactions, ebBalances, ebDerivedId, EbAuthError } from "./client";
import type { EbTransaction, EbAccount } from "./client";

const EXT_PREFIX = "eb:";
const MAX_PAGES_PER_ACCOUNT = 30;
const CURSOR_OVERLAP_DAYS = 5; // re-fetch a few days back; dedup absorbs the overlap

// Same rule as ZenMoney sync: a row edited after import belongs to the user.
const TOUCH_GRACE_MS = 2_000;
const userTouched = (tx: { createdAt: Date; updatedAt: Date }) =>
  tx.updatedAt.getTime() - tx.createdAt.getTime() > TOUCH_GRACE_MS;

interface AccountMapEntry {
  accountId: string;
  enabled: boolean;
  cursor?: string; // last synced booking_date (YYYY-MM-DD)
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
  const dryRun = opts.dryRun === true;
  const meta = (connection.meta ?? {}) as EbConnectionMeta;
  const accountsInfo = meta.accountsInfo ?? [];

  // --- Accounts: one of ours per bank account from the consented session ---
  const accountMap = { ...((connection.accountMap ?? {}) as unknown as Record<string, AccountMapEntry>) };
  let accountsCreated = 0;
  const ourAccounts = await db.account.findMany({ where: { userId } });
  const namesTaken = new Set(ourAccounts.map((a) => a.name.toLowerCase()));

  for (const acc of accountsInfo) {
    if (accountMap[acc.uid]) continue;
    const iban = acc.account_id?.iban ?? undefined;
    const baseName =
      acc.name ?? acc.product ?? (iban ? `Account ...${iban.slice(-4)}` : `${meta.aspsp?.name ?? "Bank"} account`);
    const name = namesTaken.has(baseName.toLowerCase()) ? `${baseName} (${meta.aspsp?.name ?? "bank"})` : baseName;
    const created = await db.account.create({
      data: {
        userId,
        name,
        type: "bank",
        provider: "enablebanking",
        externalId: acc.uid,
        currency: acc.currency?.toUpperCase() ?? undefined,
      },
    });
    namesTaken.add(name.toLowerCase());
    ourAccounts.push(created);
    accountMap[acc.uid] = { accountId: created.id, enabled: true };
    accountsCreated++;
  }

  const firstSync = Object.values(accountMap).every((m) => !m.cursor);
  const monthsBack = opts.monthsBack ?? 3;
  const historyFrom = new Date(Date.now() - monthsBack * 30.44 * 86_400_000).toISOString().slice(0, 10);

  // --- Pull pages per enabled account, collect candidate rows ---
  const candidates: NewRow[] = [];
  let pendingSkipped = 0;
  let authFailed: string | null = null;
  const today = new Date().toISOString().slice(0, 10);

  for (const [uid, entry] of Object.entries(accountMap)) {
    if (!entry.enabled) continue;
    const dateFrom = entry.cursor
      ? new Date(new Date(entry.cursor).getTime() - CURSOR_OVERLAP_DAYS * 86_400_000).toISOString().slice(0, 10)
      : historyFrom;
    let continuationKey: string | undefined;
    let maxDate = entry.cursor ?? "";
    try {
      for (let page = 0; page < MAX_PAGES_PER_ACCOUNT; page++) {
        const data = await ebTransactions(uid, { dateFrom, continuationKey });
        for (const t of data.transactions ?? []) {
          if (t.status !== "BOOK") {
            pendingSkipped++;
            continue; // pending rows change reference when booked; import booked only
          }
          const date = rowDate(t);
          if (!date) continue;
          const amount = round2(Math.abs(Number(t.transaction_amount.amount)));
          if (!Number.isFinite(amount) || amount === 0) continue;
          if (date > maxDate) maxDate = date;
          candidates.push({
            accountUid: uid,
            accountId: entry.accountId,
            externalId: `${EXT_PREFIX}${uid}:${t.entry_reference || ebDerivedId(uid, t)}`,
            t,
            amount,
            currency: t.transaction_amount.currency.toUpperCase(),
            date,
            isDebit: t.credit_debit_indicator === "DBIT",
          });
        }
        if (!data.continuation_key) break;
        continuationKey = data.continuation_key;
      }
    } catch (e) {
      if (e instanceof EbAuthError) {
        authFailed = e.message;
        break;
      }
      throw e;
    }
    if (!dryRun && maxDate) entry.cursor = maxDate > today ? today : maxDate;
  }

  if (authFailed) {
    await db.bankConnection.update({
      where: { id: connection.id },
      data: { status: "error", lastError: authFailed.slice(0, 500) },
    });
    throw new EbAuthError(authFailed);
  }

  // --- Drop rows already imported (by external id, either side of a transfer) ---
  const fresh: NewRow[] = [];
  let updated = 0;
  for (const row of candidates) {
    const existing = await db.transaction.findFirst({
      where: { userId, OR: [{ externalId: row.externalId }, { counterExternalId: row.externalId }] },
    });
    if (!existing) {
      fresh.push(row);
      continue;
    }
    if (existing.counterExternalId === row.externalId) continue; // credit side of a merged transfer
    if (userTouched(existing)) continue;
    const merchant = (row.isDebit ? row.t.creditor?.name : row.t.debtor?.name) ?? undefined;
    const note = (row.t.remittance_information ?? []).join(" ").trim() || undefined;
    if ((existing.merchant ?? undefined) === merchant && (existing.note ?? undefined) === note) continue;
    if (!dryRun) {
      await db.transaction.update({ where: { id: existing.id }, data: { merchant, note } });
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

  // --- Import ---
  let imported = 0;
  let transfers = 0;
  let merged = 0;

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
        const fx = await convert(row.amount, row.currency, user.baseCurrency, occurredAt);
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
      const fx = await convert(row.amount, row.currency, user.baseCurrency, occurredAt);
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
    for (const [uid, entry] of Object.entries(accountMap)) {
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
      data: { status: "active", lastError: null, lastSyncAt: new Date(), accountMap: accountMap as object },
    });
  }
  logEvent("bank_imported", userId, { imported: imported + transfers, provider: "enablebanking", dry_run: dryRun });

  return {
    ...(dryRun ? { dry_run: true } : {}),
    bank: meta.aspsp?.name,
    first_sync: firstSync,
    ...(firstSync ? { history_from: historyFrom } : {}),
    accounts_created: accountsCreated,
    accounts_synced: Object.values(accountMap).filter((m) => m.enabled).length,
    imported,
    transfers,
    updated,
    manual_twins_merged: merged,
    ...(pendingSkipped ? { pending_rows_skipped: pendingSkipped } : {}),
    balances_anchored: balancesAnchored,
    consent_valid_until: meta.validUntil,
    ...(imported > 0
      ? {
          hint: "Bank rows without a recognizable MCC or remembered merchant land in category 'other'. Review with get_transactions (category=other) and fix via update_transaction - fixes are remembered per merchant for future syncs.",
        }
      : {}),
  };
}
