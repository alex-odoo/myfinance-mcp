import { db, logEvent } from "../db";
import { convert, round2 } from "../fx";
import { pickFreeName, crossProviderOverlaps, OVERLAP_HINT } from "../accounts";
import type { OverlapWarning } from "../accounts";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "../categories";
import { merchantCategoryMap, normMerchant } from "../merchantMemory";
import { decryptToken } from "./crypto";
import { zenDiff, ZenAuthError } from "./client";
import type { ZenAccount, ZenTag } from "./client";
import { ZEN_ACCOUNT_TYPE, mapCategory } from "./mapping";

const EXT_PREFIX = "zenmoney:";

// A row whose updatedAt trails createdAt by more than this was edited after
// import (update_transaction bumps updatedAt); sync never overwrites user edits.
const TOUCH_GRACE_MS = 2_000;
const userTouched = (tx: { createdAt: Date; updatedAt: Date }) =>
  tx.updatedAt.getTime() - tx.createdAt.getTime() > TOUCH_GRACE_MS;

interface AccountMapEntry {
  accountId: string;
  enabled: boolean;
}

export interface SyncOptions {
  dryRun?: boolean;
  monthsBack?: number;
}

export async function syncZenMoney(userId: string, opts: SyncOptions = {}) {
  const connection = await db.bankConnection.findUnique({
    where: { userId_provider: { userId, provider: "zenmoney" } },
  });
  if (!connection) {
    throw new Error("ZenMoney is not connected. Use connect_zenmoney with action=paste_token first.");
  }
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("Account not found.");
  const dryRun = opts.dryRun === true;
  const firstSync = connection.serverTimestamp === 0;

  let diff;
  try {
    diff = await zenDiff(decryptToken(connection.tokenEnc), connection.serverTimestamp, connection.apiBase);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.bankConnection.update({
      where: { id: connection.id },
      data: { status: "error", lastError: message.slice(0, 500) },
    });
    throw e instanceof ZenAuthError ? e : new Error(message);
  }

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

    // Row's home = the account the money left (or arrived at, for pure income).
    const homeAccountId = t.outcome > 0 ? outAccId : inAccId;
    if (!homeAccountId) {
      skippedRows++;
      continue; // both sides live on unmapped/disabled accounts
    }

    const existing = await db.transaction.findFirst({ where: { userId, externalId } });

    const tags = (t.tag ?? []).map((id) => tagById.get(id)).filter((x): x is ZenTag => !!x);
    const type = isTransfer ? ("transfer" as const) : t.outcome > 0 ? ("expense" as const) : ("income" as const);
    const merchant = (t.merchant ? merchantById.get(t.merchant) : undefined) ?? t.payee ?? undefined;
    let category: string | null = null;
    if (!isTransfer) {
      const mapped = mapCategory(tags, tagById, t.mcc);
      category = mapped.category;
      if (mapped.unmappedTag) unmappedTags.set(mapped.unmappedTag, (unmappedTags.get(mapped.unmappedTag) ?? 0) + 1);
      if (type === "income" && !(INCOME_CATEGORIES as readonly string[]).includes(category)) category = "other";
      if (!category || category === "other") {
        const remembered = merchant ? memory.get(normMerchant(merchant)) : undefined;
        const valid = type === "expense" ? EXPENSE_CATEGORIES : INCOME_CATEGORIES;
        if (remembered && (valid as readonly string[]).includes(remembered)) category = remembered;
      }
    }
    const amount = round2(t.outcome > 0 ? t.outcome : t.income);
    const currency =
      (t.outcome > 0 ? currencyOf(t.outcomeInstrument) : currencyOf(t.incomeInstrument)) ?? user.baseCurrency;
    const occurredAt = new Date(`${t.date}T00:00:00.000Z`);
    // op* = operation currency differs from account currency; keep the
    // account-currency amount canonical and preserve the charged amount in the note.
    const opNote =
      t.opOutcome && t.opOutcomeInstrument && currencyOf(t.opOutcomeInstrument) !== currency
        ? `charged ${t.opOutcome} ${currencyOf(t.opOutcomeInstrument)}`
        : undefined;
    const note = [t.comment ?? undefined, opNote].filter(Boolean).join(" | ") || undefined;

    if (existing) {
      if (userTouched(existing)) continue; // user's version wins, silently
      if (dryRun) continue;
      const fx = await convert(amount, currency, user.baseCurrency, occurredAt);
      const changedFields =
        Number(existing.amount) !== amount ||
        existing.currency !== currency ||
        existing.occurredAt.getTime() !== occurredAt.getTime() ||
        (existing.merchant ?? undefined) !== merchant ||
        (existing.note ?? undefined) !== note;
      if (!changedFields) continue;
      await db.transaction.update({
        where: { id: existing.id },
        data: { amount, currency, amountBase: fx.converted, fxRate: fx.rate, merchant, note, occurredAt },
      });
      updated++;
      continue;
    }

    if (isTransfer) {
      if (!dryRun) {
        const fromCur = currencyOf(t.outcomeInstrument) ?? user.baseCurrency;
        const toCur = currencyOf(t.incomeInstrument) ?? user.baseCurrency;
        const fx = await convert(round2(t.outcome), fromCur, user.baseCurrency, occurredAt);
        const fromAcc = ourAccounts.find((a) => a.id === outAccId) ?? { entity: "personal" };
        await db.transaction.create({
          data: {
            userId,
            // Transfer with an unmapped side degrades to a one-legged transfer:
            // money verifiably left (or entered) the tracked world; never spending.
            accountId: outAccId ?? homeAccountId,
            type: "transfer",
            amount: round2(t.outcome),
            currency: fromCur,
            amountBase: fx.converted,
            fxRate: fx.rate,
            note:
              note ??
              (!outAccId
                ? `from ${zenAccountById.get(t.outcomeAccount!)?.title ?? "unsynced account"} (not synced)`
                : !inAccId
                  ? `to ${zenAccountById.get(t.incomeAccount!)?.title ?? "unsynced account"} (not synced)`
                  : undefined),
            occurredAt,
            source: "bank",
            externalId,
            entity: fromAcc.entity,
            counterAccountId: inAccId ?? null,
            counterAmount: inAccId ? round2(t.income) : null,
            counterCurrency: inAccId ? toCur : null,
          },
        });
      }
      transfers++;
      continue;
    }

    // Manual/receipt twin (user hand-logged what ZenMoney now confirms):
    // merge - move to the synced account, stamp the dedup key, keep user's fields.
    const windowStart = new Date(occurredAt.getTime() - 2 * 86_400_000);
    const windowEnd = new Date(occurredAt.getTime() + 2 * 86_400_000);
    const twin = (
      await db.transaction.findMany({
        where: {
          userId,
          type,
          currency,
          source: { in: ["manual", "receipt"] },
          occurredAt: { gte: windowStart, lte: windowEnd },
        },
      })
    ).find((c) => Math.abs(Number(c.amount) - amount) <= 0.009);
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
      const fx = await convert(amount, currency, user.baseCurrency, occurredAt);
      const homeAcc = ourAccounts.find((a) => a.id === homeAccountId);
      await db.transaction.create({
        data: {
          userId,
          accountId: homeAccountId,
          type,
          amount,
          currency,
          amountBase: fx.converted,
          fxRate: fx.rate,
          categoryKey: category,
          merchant,
          note,
          occurredAt,
          source: "bank",
          externalId,
          entity: homeAcc?.entity ?? "personal",
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
        lastError: null,
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
    balances_anchored: balancesAnchored,
    ...(unmappedTags.size
      ? {
          unmapped_tags: [...unmappedTags.entries()].map(([tag, count]) => ({ tag, count })),
          hint: "Rows with unmapped tags were categorized as 'other'. Review them with get_transactions (category=other) and fix via update_transaction; tell the user which ZenMoney tags they correspond to.",
        }
      : {}),
  };
}
