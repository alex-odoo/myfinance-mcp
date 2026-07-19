import { db } from "./db";

// User's explicit category choice per merchant, learned from update_transaction
// edits. Bank syncs consult it before MCC guessing, so one correction sticks
// on every future import of the same merchant.

export const normMerchant = (m: string): string => m.trim().toLowerCase();

export async function rememberMerchantCategory(userId: string, merchant: string, categoryKey: string): Promise<void> {
  const key = normMerchant(merchant);
  if (!key) return;
  await db.merchantCategory.upsert({
    where: { userId_merchant: { userId, merchant: key } },
    update: { categoryKey },
    create: { userId, merchant: key, categoryKey },
  });
}

export async function merchantCategoryMap(
  userId: string,
  merchants: Array<string | undefined>
): Promise<Map<string, string>> {
  const keys = [...new Set(merchants.filter((m): m is string => !!m).map(normMerchant))].filter(Boolean);
  if (!keys.length) return new Map();
  const rows = await db.merchantCategory.findMany({ where: { userId, merchant: { in: keys } } });
  return new Map(rows.map((r) => [r.merchant, r.categoryKey]));
}
