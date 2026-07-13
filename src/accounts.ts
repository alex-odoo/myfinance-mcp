import { db } from "./db";
import { convert, round2 } from "./fx";

export const ACCOUNT_TYPES = ["cash", "bank", "card", "investment", "manual"] as const;

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
