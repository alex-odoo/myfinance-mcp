import { db, logEvent } from "../db";
import { convert, round2 } from "../fx";
import { pickFreeName, crossProviderOverlaps, OVERLAP_HINT } from "../accounts";
import type { OverlapWarning } from "../accounts";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "../categories";
import { merchantCategoryMap, normMerchant } from "../merchantMemory";
import type { BankConnection, Transaction, User } from "../generated/prisma/client";
import type { TxType } from "../generated/prisma/enums";
import { decryptToken } from "./crypto";
import { zenDiff, ZenAuthError } from "./client";
import type { ZenAccount, ZenTag } from "./client";
import { ZEN_ACCOUNT_TYPE, mapCategory } from "./mapping";

const EXT_PREFIX = "zenmoney:";

// A row whose updatedAt trails createdAt by more than this was edited after
// import (update_transaction bumps updatedAt); sync never overwrites user edits.
// So a sync write to an existing row pins updatedAt back to createdAt (Prisma
// keeps an explicitly supplied @updatedAt value): the sync's own updates never
// read as edits. Rows that older sync versions updated already sit past the
// window and cannot be told from real edits; they stay frozen.
const TOUCH_GRACE_MS = 2_000;
const userTouched = (tx: { createdAt: Date; updatedAt: Date }) =>
  tx.updatedAt.getTime() - tx.createdAt.getTime() > TOUCH_GRACE_MS;

/**
 * Per-row FX for bank syncs, shared by all connectors. A row in a currency no
 * rate source publishes (RUB, KZT, GEL, ...) is skipped and counted instead of
 * aborting the sync. An FX OUTAGE is different: it rethrows, the sync fails
 * without moving its cursor and the next run retries. Telling them apart: UAH
 * failing means NBU is down; any other currency failing while USD prices on
 * the same date means the ECB set is there and simply lacks it.
 *
 * Cursors move past skipped rows. Holding a cursor at the oldest skipped row
 * would re-pull and re-skip it on every run, forever for a currency no source
 * will ever price, and a RUB account would pin the whole history behind it. A
 * currency gets priced only when fx.ts gains a source; a full re-sync then
 * imports the skipped rows, and external-id dedup keeps that idempotent.
 */
export class RowPricer {
  readonly unpriced = new Map<string, number>(); // currency -> rows skipped
  private readonly dead = new Map<string, string>(); // "FROM>TO|date" -> currency without a rate
  private readonly ecbDay = new Map<string, boolean>();

  constructor(private readonly base: string) {}

  async price(amount: number, currency: string, date: Date): Promise<{ converted: number; rate: number } | null> {
    const day = date.toISOString().slice(0, 10);
    const pairKey = `${currency}>${this.base}|${day}`;
    const known = this.dead.get(pairKey);
    if (known) return this.skip(known);
    try {
      return await convert(amount, currency, this.base, date);
    } catch (e) {
      const code = e instanceof Error ? /^Unknown currency "([A-Za-z]{3})"/.exec(e.message)?.[1]?.toUpperCase() : undefined;
      if (!code || code === "UAH" || !(await this.ecbPublished(date, day))) throw e;
      // The probe may have just refilled the day after a blip: one more try.
      const retry = await convert(amount, currency, this.base, date).catch(() => null);
      if (retry) return retry;
      this.dead.set(pairKey, code);
      return this.skip(code);
    }
  }

  /** Short lastError for a sync that skipped rows: currency codes only. */
  lastError(): string | null {
    if (this.unpriced.size === 0) return null;
    const rows = [...this.unpriced.values()].reduce((s, n) => s + n, 0);
    return `Skipped ${rows} row(s) with no exchange rate: ${[...this.unpriced.keys()].join(", ")}.`;
  }

  private skip(code: string): null {
    this.unpriced.set(code, (this.unpriced.get(code) ?? 0) + 1);
    return null;
  }

  private async ecbPublished(date: Date, day: string): Promise<boolean> {
    let ok = this.ecbDay.get(day);
    if (ok === undefined) {
      ok = await convert(1, "USD", "EUR", date).then(
        () => true,
        () => false
      );
      this.ecbDay.set(day, ok);
    }
    return ok;
  }
}

interface AccountMapEntry {
  accountId: string;
  enabled: boolean;
}

export interface SyncOptions {
  dryRun?: boolean;
  monthsBack?: number;
}

// The row a ZenMoney transaction maps to. Create and update share it, so a
// change made in ZenMoney (tag, type, account, counter leg) reaches every row
// the user has not edited.
interface Planned {
  accountId: string;
  type: TxType;
  // A transfer's amount is the net outflow of accountId: a one-legged transfer
  // INTO a synced account is negative (computeBalance subtracts it).
  amount: number;
  currency: string;
  categoryKey: string | null;
  merchant: string | null;
  note: string | null;
  occurredAt: Date;
  counterAccountId: string | null;
  counterAmount: number | null;
  counterCurrency: string | null;
}

const differs = (e: Transaction, p: Planned) =>
  e.accountId !== p.accountId ||
  e.type !== p.type ||
  Number(e.amount) !== p.amount ||
  e.currency !== p.currency ||
  e.occurredAt.getTime() !== p.occurredAt.getTime() ||
  (e.categoryKey ?? null) !== p.categoryKey ||
  (e.merchant ?? null) !== p.merchant ||
  (e.note ?? null) !== p.note ||
  (e.counterAccountId ?? null) !== p.counterAccountId ||
  (e.counterAmount === null ? null : Number(e.counterAmount)) !== p.counterAmount ||
  (e.counterCurrency ?? null) !== p.counterCurrency;

export async function syncZenMoney(userId: string, opts: SyncOptions = {}) {
  const connection = await db.bankConnection.findUnique({
    where: { userId_provider: { userId, provider: "zenmoney" } },
  });
  if (!connection) {
    throw new Error("ZenMoney is not connected. Use connect_zenmoney with action=paste_token first.");
  }
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("Account not found.");
  try {
    return await runSync(connection, user, opts);
  } catch (e) {
    // Only a rejected token is the user's to fix: status "error" drops the
    // connection from autosync until they paste a fresh one. Anything else (a
    // 5xx, a timeout, an FX outage, a bug) records lastError, stays "active",
    // and the next autosync tick retries.
    const message = e instanceof Error ? e.message : String(e);
    await db.bankConnection
      .update({
        where: { id: connection.id },
        data: { ...(e instanceof ZenAuthError ? { status: "error" } : {}), lastError: message.slice(0, 500) },
      })
      .catch(() => {});
    throw e;
  }
}

async function runSync(connection: BankConnection, user: User, opts: SyncOptions) {
  const userId = user.id;
  const dryRun = opts.dryRun === true;
  const firstSync = connection.serverTimestamp === 0;

  const diff = await zenDiff(decryptToken(connection.tokenEnc), connection.serverTimestamp, connection.apiBase);

  const instrumentById = new Map((diff.instrument ?? []).map((i) => [i.id, i]));
  const tagById = new Map<string, ZenTag>((diff.tag ?? []).map((t) => [t.id, t]));
  const merchantById = new Map((diff.merchant ?? []).map((m) => [m.id, m.title]));
  const zenAccountById = new Map<string, ZenAccount>((diff.account ?? []).map((a) => [a.id, a]));
  const currencyOf = (instrument: number | null | undefined): string | undefined =>
    instrument != null ? instrumentById.get(instrument)?.shortTitle?.toUpperCase() : undefined;

  // --- Accounts: map every syncable ZenMoney account to one of ours ---
  const accountMap = { ...((connection.accountMap ?? {}) as unknown as Record<string, AccountMapEntry>) };
  const skippedAccounts: Array<{ title: string; reason: string }> = [];
  const overlapWarnings: OverlapWarning[] = [];
  let accountsCreated = 0;
  const ourAccounts = await db.account.findMany({ where: { userId } });
  const namesTaken = new Set(ourAccounts.map((a) => a.name.toLowerCase()));
  const mappedOurIds = new Set(Object.values(accountMap).map((m) => m.accountId));

  for (const zen of diff.account ?? []) {
    if (accountMap[zen.id]) continue; // already mapped (stays synced even if archived later)
    const type = ZEN_ACCOUNT_TYPE[zen.type];
    if (!type) {
      skippedAccounts.push({ title: zen.title, reason: `type "${zen.type}" not synced (loans/debt out of scope)` });
      continue;
    }
    // The account this ZenMoney account fed before a disconnect (the map went
    // with the connection row): re-attach it even if renamed or suffixed, so a
    // full re-sync after reconnecting dedups instead of duplicating.
    const fed = ourAccounts.find((a) => a.provider === "zenmoney" && a.externalId === zen.id && !mappedOurIds.has(a.id));
    if (fed) {
      accountMap[zen.id] = { accountId: fed.id, enabled: true };
      mappedOurIds.add(fed.id);
      continue;
    }
    if (zen.archive) {
      skippedAccounts.push({ title: zen.title, reason: "archived in ZenMoney" });
      continue;
    }
    const currency = currencyOf(zen.instrument);
    // Adopt an existing same-name account (user pre-created it by hand) unless
    // it is already claimed by another ZenMoney account. A sync NEVER adopts
    // an account owned by a different bank provider: two live feeds on one
    // account row is the worst duplication mode.
    const existing = ourAccounts.find(
      (a) =>
        a.name.toLowerCase() === zen.title.toLowerCase() &&
        !mappedOurIds.has(a.id) &&
        (!a.provider || a.provider === "zenmoney")
    );
    if (existing) {
      accountMap[zen.id] = { accountId: existing.id, enabled: true };
      mappedOurIds.add(existing.id);
      continue;
    }
    const name = pickFreeName(zen.title, namesTaken, currency ? [currency, "ZenMoney"] : ["ZenMoney"]);
    let created;
    try {
      created = await db.account.create({
        data: { userId, name, type, provider: "zenmoney", externalId: zen.id, currency },
      });
    } catch {
      throw new Error(
        `Cannot create account "${name}" for ZenMoney account "${zen.title}": the name is already taken. ` +
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
    accountMap[zen.id] = { accountId: created.id, enabled: true };
    mappedOurIds.add(created.id);
    accountsCreated++;
  }

  // Persist the map right away: a failure later in the sync must not orphan
  // the accounts just created (same-name adoption entries included).
  if (accountsCreated > 0 || Object.keys(accountMap).length > Object.keys((connection.accountMap ?? {}) as object).length) {
    await db.bankConnection.update({ where: { id: connection.id }, data: { accountMap: accountMap as object } });
  }

  const ourAccountId = (zenId: string | null | undefined): string | undefined => {
    if (!zenId) return undefined;
    const entry = accountMap[zenId];
    return entry && entry.enabled ? entry.accountId : undefined;
  };
  const entityOf = (accountId: string) => ourAccounts.find((a) => a.id === accountId)?.entity ?? "personal";
  const titleOf = (zenId: string | null) => (zenId ? zenAccountById.get(zenId)?.title : undefined) ?? "unsynced account";

  // --- Transactions ---
  const cutoff =
    firstSync && opts.monthsBack
      ? new Date(Date.now() - opts.monthsBack * 30.44 * 86_400_000).toISOString().slice(0, 10)
      : undefined;
  const rows = (diff.transaction ?? [])
    .filter((t) => !t.deleted)
    .filter((t) => !cutoff || t.date >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date));

  let imported = 0;
  let transfers = 0;
  let updated = 0;
  let merged = 0;
  let skippedRows = 0;
  const unmappedTags = new Map<string, number>();
  const pricer = new RowPricer(user.baseCurrency);

  // User's remembered per-merchant categories fill the gaps tags don't cover
  // (ZenMoney tags are the user's own labels, so they keep priority).
  const memory = await merchantCategoryMap(
    userId,
    rows.map((t) => (t.merchant ? merchantById.get(t.merchant) : undefined) ?? t.payee ?? undefined)
  );

  for (const t of rows) {
    const isTransfer = t.income > 0 && t.outcome > 0 && !!t.incomeAccount && !!t.outcomeAccount;
    const outAccId = ourAccountId(t.outcomeAccount);
    const inAccId = ourAccountId(t.incomeAccount);
    const externalId = `${EXT_PREFIX}${t.id}`;

    // Row's home = the synced account it books on: where the money left, or
    // where it arrived (pure income, or a transfer INTO a synced account from
    // an unsynced one: debt/loan, archived or disabled).
    const incoming = isTransfer && !outAccId;
    const homeAccountId = isTransfer ? (outAccId ?? inAccId) : t.outcome > 0 ? outAccId : inAccId;
    if (!homeAccountId) {
      skippedRows++;
      continue; // both sides live on unmapped/disabled accounts
    }

    const existing = await db.transaction.findFirst({
      where: { userId, OR: [{ externalId }, { counterExternalId: externalId }] },
    });
    // Absorbed leg of a transfer merged via update_transaction: already
    // represented by the surviving row, never re-create it.
    if (existing && existing.externalId !== externalId) continue;

    const occurredAt = new Date(`${t.date}T00:00:00.000Z`);
    const outCur = currencyOf(t.outcomeInstrument) ?? user.baseCurrency;
    const inCur = currencyOf(t.incomeInstrument) ?? user.baseCurrency;
    const currency = t.outcome > 0 && !incoming ? outCur : inCur;
    const merchant = (t.merchant ? merchantById.get(t.merchant) : undefined) ?? t.payee ?? undefined;
    // op* = operation currency differs from account currency; keep the
    // account-currency amount canonical and preserve the charged amount in the note.
    const opNote =
      !incoming && t.opOutcome && t.opOutcomeInstrument && currencyOf(t.opOutcomeInstrument) !== currency
        ? `charged ${t.opOutcome} ${currencyOf(t.opOutcomeInstrument)}`
        : undefined;
    const note = [t.comment ?? undefined, opNote].filter(Boolean).join(" | ") || undefined;

    let planned: Planned;
    if (isTransfer) {
      // Transfer with an unmapped side degrades to a one-legged transfer: money
      // verifiably left (or entered) the tracked world; never spending/income.
      const legNote = incoming
        ? `from ${titleOf(t.outcomeAccount)} (not synced)`
        : !inAccId
          ? `to ${titleOf(t.incomeAccount)} (not synced)`
          : undefined;
      planned = {
        accountId: homeAccountId,
        type: "transfer",
        amount: incoming ? -round2(t.income) : round2(t.outcome),
        currency,
        categoryKey: null,
        merchant: null,
        note: note ?? legNote ?? null,
        occurredAt,
        counterAccountId: incoming ? null : (inAccId ?? null),
        counterAmount: !incoming && inAccId ? round2(t.income) : null,
        counterCurrency: !incoming && inAccId ? inCur : null,
      };
    } else {
      const type = t.outcome > 0 ? ("expense" as const) : ("income" as const);
      const tags = (t.tag ?? []).map((id) => tagById.get(id)).filter((x): x is ZenTag => !!x);
      const mapped = mapCategory(tags, tagById, t.mcc);
      let category = mapped.category;
      if (mapped.unmappedTag) unmappedTags.set(mapped.unmappedTag, (unmappedTags.get(mapped.unmappedTag) ?? 0) + 1);
      if (type === "income" && !(INCOME_CATEGORIES as readonly string[]).includes(category)) category = "other";
      if (category === "other") {
        const remembered = merchant ? memory.get(normMerchant(merchant)) : undefined;
        const valid = type === "expense" ? EXPENSE_CATEGORIES : INCOME_CATEGORIES;
        if (remembered && (valid as readonly string[]).includes(remembered)) category = remembered;
      }
      planned = {
        accountId: homeAccountId,
        type,
        amount: round2(t.outcome > 0 ? t.outcome : t.income),
        currency,
        categoryKey: category,
        merchant: merchant ?? null,
        note: note ?? null,
        occurredAt,
        counterAccountId: null,
        counterAmount: null,
        counterCurrency: null,
      };
    }

    if (existing) {
      if (userTouched(existing)) continue; // user's version wins, silently
      if (!differs(existing, planned)) continue;
      if (!dryRun) {
        const fx = await pricer.price(planned.amount, planned.currency, occurredAt);
        if (!fx) continue; // no rate: counted in skipped_unpriced, row left as it was
        await db.transaction.update({
          where: { id: existing.id },
          data: {
            ...planned,
            amountBase: fx.converted,
            fxRate: fx.rate,
            ...(existing.accountId !== planned.accountId ? { entity: entityOf(planned.accountId) } : {}),
            updatedAt: existing.createdAt, // a sync write, not a user edit
          },
        });
      }
      updated++;
      continue;
    }

    if (planned.type === "transfer") {
      if (!dryRun) {
        const fx = await pricer.price(planned.amount, planned.currency, occurredAt);
        if (!fx) continue;
        await db.transaction.create({
          data: {
            userId,
            ...planned,
            amountBase: fx.converted,
            fxRate: fx.rate,
            source: "bank",
            externalId,
            entity: entityOf(homeAccountId),
          },
        });
      }
      transfers++;
      continue;
    }

    // Manual/receipt twin (user hand-logged what ZenMoney now confirms):
    // merge - move to the synced account, stamp the dedup key, keep user's
    // fields. updatedAt is deliberately NOT pinned here: the row is the user's
    // own record, and the bump keeps it protected from later provider edits
    // and deletions, as before.
    const windowStart = new Date(occurredAt.getTime() - 2 * 86_400_000);
    const windowEnd = new Date(occurredAt.getTime() + 2 * 86_400_000);
    const twin = (
      await db.transaction.findMany({
        where: {
          userId,
          type: planned.type,
          currency,
          source: { in: ["manual", "receipt"] },
          occurredAt: { gte: windowStart, lte: windowEnd },
        },
      })
    ).find((c) => Math.abs(Number(c.amount) - planned.amount) <= 0.009);
    if (twin) {
      if (!dryRun) {
        await db.transaction.update({
          where: { id: twin.id },
          data: { accountId: homeAccountId, externalId, source: "bank" },
        });
      }
      merged++;
      continue;
    }

    if (!dryRun) {
      const fx = await pricer.price(planned.amount, planned.currency, occurredAt);
      if (!fx) continue;
      await db.transaction.create({
        data: {
          userId,
          ...planned,
          amountBase: fx.converted,
          fxRate: fx.rate,
          source: "bank",
          externalId,
          entity: entityOf(homeAccountId),
        },
      });
    }
    imported++;
  }

  // --- Deletions (ZenMoney removed a transaction we imported) ---
  let deleted = 0;
  let keptUserModified = 0;
  const deletedIds = [
    ...(diff.deletion ?? []).filter((d) => d.object === "transaction").map((d) => d.id),
    ...(diff.transaction ?? []).filter((t) => t.deleted).map((t) => t.id),
  ];
  for (const zenId of deletedIds) {
    const tx = await db.transaction.findFirst({ where: { userId, externalId: `${EXT_PREFIX}${zenId}` } });
    if (!tx) continue;
    if (userTouched(tx)) {
      keptUserModified++; // user edited it after import - never destroy their work
      continue;
    }
    if (!dryRun) await db.transaction.delete({ where: { id: tx.id } });
    deleted++;
  }

  // --- Balance anchoring: provider balances are authoritative for synced accounts ---
  let balancesAnchored = 0;
  if (!dryRun) {
    const today = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: user.timezone }).format(new Date())}T00:00:00.000Z`);
    for (const zen of diff.account ?? []) {
      const entry = accountMap[zen.id];
      if (!entry?.enabled || zen.balance == null) continue;
      const currency = currencyOf(zen.instrument) ?? user.baseCurrency;
      await db.balanceSnapshot.upsert({
        where: { accountId_asOf: { accountId: entry.accountId, asOf: today } },
        update: { amount: round2(zen.balance), currency },
        create: { userId, accountId: entry.accountId, amount: round2(zen.balance), currency, asOf: today },
      });
      balancesAnchored++;
    }
  }

  if (!dryRun) {
    await db.bankConnection.update({
      where: { id: connection.id },
      data: {
        serverTimestamp: diff.serverTimestamp,
        status: "active",
        lastError: pricer.lastError(),
        lastSyncAt: new Date(),
        accountMap: accountMap as object,
      },
    });
  }
  logEvent("bank_imported", userId, { imported: imported + transfers, provider: "zenmoney", dry_run: dryRun });

  return {
    ...(dryRun ? { dry_run: true } : {}),
    first_sync: firstSync,
    ...(cutoff ? { history_from: cutoff } : {}),
    accounts_created: accountsCreated,
    accounts_synced: Object.values(accountMap).filter((m) => m.enabled).length,
    ...(skippedAccounts.length ? { accounts_skipped: skippedAccounts } : {}),
    ...(overlapWarnings.length ? { overlap_warnings: overlapWarnings } : {}),
    imported,
    transfers,
    updated,
    manual_twins_merged: merged,
    deleted,
    ...(keptUserModified ? { kept_user_modified: keptUserModified } : {}),
    ...(skippedRows ? { rows_on_unsynced_accounts: skippedRows } : {}),
    ...(pricer.unpriced.size
      ? {
          skipped_unpriced: Object.fromEntries(pricer.unpriced),
          skipped_unpriced_hint:
            "Not imported: no exchange-rate source covers these currencies yet. Tell the user. A full re-sync (connect_zenmoney disconnect, then paste_token again) imports them once covered, without duplicating rows already imported.",
        }
      : {}),
    balances_anchored: balancesAnchored,
    ...(unmappedTags.size
      ? {
          unmapped_tags: [...unmappedTags.entries()].map(([tag, count]) => ({ tag, count })),
          hint: "Rows with unmapped tags were categorized as 'other'. Review them with get_transactions (category=other) and fix via update_transaction; tell the user which ZenMoney tags they correspond to.",
        }
      : {}),
  };
}
