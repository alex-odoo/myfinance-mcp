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

/**
 * Balance = latest snapshot (end of its date) + signed flows after it.
 * Without snapshots it is just the tracked-flow sum, which is only as complete
 * as the logging; log_balance snapshots are the honest anchor.
 *
 * An account without a currency (the auto-created Manual one) holds whatever
 * was logged and is shown in the user's base. Foreign-currency flows are
 * summed per (currency, day) and converted once per group: one FX lookup per
 * row made get_accounts cost a round trip per transaction.
 */
export async function computeBalance(
  account: { id: string; userId: string; currency: string | null },
  user: { baseCurrency: string; timezone: string }
): Promise<{ balance: number; currency: string; anchoredAt?: string }> {
  const currency = account.currency ?? user.baseCurrency;
  const snapshot = await db.balanceSnapshot.findFirst({
    where: { accountId: account.id },
    orderBy: { asOf: "desc" },
  });

  let balance = 0;
  const foreign = new Map<string, { currency: string; date: Date; sum: number }>();
  const add = (amount: number, cur: string, date: Date) => {
    if (cur === currency) {
      balance += amount;
      return;
    }
    const key = `${cur}:${date.toISOString().slice(0, 10)}`;
    const g = foreign.get(key) ?? { currency: cur, date, sum: 0 };
    g.sum += amount;
    foreign.set(key, g);
  };

  // Flows after the anchor. A snapshot logged on its own day ("my balance is
  // X now") cannot contain cash/receipt rows the user logs later that day, so
  // those count too; bank rows of that day are assumed already in the bank's
  // balance (end-of-day semantics) and never counted twice.
  let after = {};
  if (snapshot) {
    add(Number(snapshot.amount), snapshot.currency, snapshot.asOf);
    const loggedOnAsOf =
      new Intl.DateTimeFormat("en-CA", { timeZone: user.timezone }).format(snapshot.createdAt) ===
      snapshot.asOf.toISOString().slice(0, 10);
    after = {
      OR: [
        { occurredAt: { gt: snapshot.asOf } },
        ...(loggedOnAsOf
          ? [{ occurredAt: snapshot.asOf, source: { in: ["manual" as const, "receipt" as const] }, createdAt: { gt: snapshot.createdAt } }]
          : []),
      ],
    };
  }

  const outgoing = await db.transaction.findMany({
    where: { userId: account.userId, accountId: account.id, ...after },
    select: { type: true, amount: true, currency: true, occurredAt: true },
  });
  // Income adds; expense and transfer-out leave the account. A refund is a
  // negative expense and an incoming one-legged transfer a negative transfer,
  // so both flip sign here without special cases.
  for (const t of outgoing) add(t.type === "income" ? Number(t.amount) : -Number(t.amount), t.currency, t.occurredAt);

  const incoming = await db.transaction.findMany({
    where: { userId: account.userId, counterAccountId: account.id, type: "transfer", ...after },
    select: { amount: true, currency: true, counterAmount: true, counterCurrency: true, occurredAt: true },
  });
  for (const t of incoming) {
    // counterAmount and counterCurrency only ever travel together; without
    // them the leg arrived in the sending currency.
    const received = t.counterAmount !== null && t.counterCurrency;
    add(received ? Number(t.counterAmount) : Number(t.amount), received ? t.counterCurrency! : t.currency, t.occurredAt);
  }

  for (const g of foreign.values()) {
    balance += (await convert(round2(g.sum), g.currency, currency, g.date)).converted;
  }

  return {
    balance: round2(balance),
    currency,
    anchoredAt: snapshot ? snapshot.asOf.toISOString().slice(0, 10) : undefined,
  };
}
