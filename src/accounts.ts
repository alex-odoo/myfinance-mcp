import { db } from "./db";
import { convert, round2 } from "./fx";

export const ACCOUNT_TYPES = ["cash", "bank", "card", "investment", "manual"] as const;

/**
 * First free name among base, then "base (suffix)" for each suffix, then
 * "base (2)", "base (3)"... Connectors need this because multi-currency banks
 * repeat the holder's name on every sub-account and (userId, name) is unique.
 */
export function pickFreeName(base: string, takenLower: Set<string>, suffixes: string[] = []): string {
  const candidates = [base, ...suffixes.map((s) => `${base} (${s})`)];
  for (const c of candidates) if (!takenLower.has(c.toLowerCase())) return c;
  for (let i = 2; ; i++) {
    const c = `${base} (${i})`;
    if (!takenLower.has(c.toLowerCase())) return c;
  }
}

export async function resolveAccount(userId: string, name?: string) {
  if (!name || name.toLowerCase() === "manual") {
    return db.account.upsert({
      where: { userId_name: { userId, name: "Manual" } },
      update: {},
      create: { userId, name: "Manual", type: "manual" },
    });
  }
  const accounts = await db.account.findMany({ where: { userId } });
  const found = accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!found) {
    const names = accounts.map((a) => a.name).join(", ") || "(none)";
    throw new Error(`Account "${name}" not found. Existing accounts: ${names}. Create it with create_account first.`);
  }
  return found;
}

/**
 * Overlap heuristic (deliberately dumb, the LLM client does the judgement):
 * an account newly created by a sync may be the SAME real bank account already
 * arriving from a DIFFERENT provider. Same currency + normalized names equal
 * or containing each other (shorter side >= 4 chars). Warn only, never block.
 */
export function crossProviderOverlaps(
  created: { name: string; currency: string | null; provider: string | null },
  accounts: Array<{ name: string; currency: string | null; provider: string | null }>
): Array<{ name: string; provider: string }> {
  const strip = (n: string) => n.toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").trim();
  const cn = strip(created.name);
  return accounts
    .filter((a) => a.provider && a.provider !== created.provider)
    .filter((a) => (a.currency ?? "") === (created.currency ?? ""))
    .filter((a) => {
      const an = strip(a.name);
      if (an === cn) return true;
      const shorter = an.length <= cn.length ? an : cn;
      return shorter.length >= 4 && (an.includes(cn) || cn.includes(an));
    })
    .map((a) => ({ name: a.name, provider: a.provider! }));
}

export interface OverlapWarning {
  created_account: string;
  existing_account: string;
  existing_provider: string;
  hint: string;
}

export const OVERLAP_HINT =
  "These may be the SAME real bank account arriving from two sources, which will duplicate every transaction. " +
  "Ask the user; if confirmed, disable one side with connect_zenmoney or connect_bank action=set_account_sync enabled=false, " +
  "or unify history with merge_accounts.";

interface MapEntry {
  accountId: string;
  enabled: boolean;
}

/** Joined view of a connection's accountMap and our account rows (deleted accounts skipped). */
export async function connectionAccounts(connection: { accountMap: unknown }) {
  const map = (connection.accountMap ?? {}) as Record<string, MapEntry>;
  const ids = Object.values(map).map((m) => m.accountId);
  if (ids.length === 0) return [];
  const accounts = await db.account.findMany({ where: { id: { in: ids } } });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out = [];
  for (const m of Object.values(map)) {
    const a = byId.get(m.accountId);
    if (a) out.push({ id: a.id, name: a.name, currency: a.currency, enabled: m.enabled });
  }
  return out;
}

/** Flip the enabled flag for one synced account; returns the account name. */
export async function setAccountSync(
  connection: { id: string; accountMap: unknown },
  accountRef: string,
  enabled: boolean
): Promise<string> {
  const list = await connectionAccounts(connection);
  const target =
    list.find((a) => a.id === accountRef) ?? list.find((a) => a.name.toLowerCase() === accountRef.toLowerCase());
  if (!target) {
    const names = list.map((a) => a.name).join(", ") || "(none)";
    throw new Error(`Account "${accountRef}" is not part of this connection. Synced accounts: ${names}.`);
  }
  const map = { ...((connection.accountMap ?? {}) as Record<string, MapEntry>) };
  for (const entry of Object.values(map)) {
    if (entry.accountId === target.id) entry.enabled = enabled;
  }
  await db.bankConnection.update({ where: { id: connection.id }, data: { accountMap: map as object } });
  return target.name;
}

async function inAccountCurrency(
  amount: number,
  txCurrency: string,
  accCurrency: string,
  date: Date
): Promise<number> {
  if (txCurrency === accCurrency) return amount;
  const { converted } = await convert(amount, txCurrency, accCurrency, date);
  return converted;
}

/**
 * Balance = latest snapshot (end of its date) + signed flows after it.
 * Without snapshots it is just the tracked-flow sum, which is only as complete
 * as the logging; log_balance snapshots are the honest anchor.
 */
export async function computeBalance(account: {
  id: string;
  userId: string;
  currency: string | null;
}): Promise<{ balance: number; currency: string; anchoredAt?: string }> {
  const currency = account.currency ?? "EUR";
  const snapshot = await db.balanceSnapshot.findFirst({
    where: { accountId: account.id },
    orderBy: { asOf: "desc" },
  });
  let balance = snapshot ? Number(snapshot.amount) : 0;
  const after = snapshot ? snapshot.asOf : undefined;

  const outgoing = await db.transaction.findMany({
    where: { accountId: account.id, ...(after ? { occurredAt: { gt: after } } : {}) },
  });
  for (const t of outgoing) {
    const value = await inAccountCurrency(Number(t.amount), t.currency, currency, t.occurredAt);
    if (t.type === "income") balance += value;
    else balance -= value; // expense and transfer-out both leave the account
  }

  const incoming = await db.transaction.findMany({
    where: { counterAccountId: account.id, type: "transfer", ...(after ? { occurredAt: { gt: after } } : {}) },
  });
  for (const t of incoming) {
    const amt = t.counterAmount !== null ? Number(t.counterAmount) : Number(t.amount);
    const cur = t.counterCurrency ?? t.currency;
    balance += await inAccountCurrency(amt, cur, currency, t.occurredAt);
  }

  return {
    balance: round2(balance),
    currency,
    anchoredAt: snapshot ? snapshot.asOf.toISOString().slice(0, 10) : undefined,
  };
}
