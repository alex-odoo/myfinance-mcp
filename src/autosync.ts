import { db, logEvent } from "./db";
import { syncEnableBanking } from "./enablebanking/sync";
import { syncZenMoney } from "./zenmoney/sync";

// Server-side daily pull for every healthy bank connection, so transactions
// arrive without the user asking. The hourly tick picks up whatever became
// stale; sync functions already persist status/lastError on failure (expired
// consent flips the connection to "error", which drops it from this list
// until the user reconnects).
const STALE_MS = 20 * 60 * 60 * 1000; // ~daily with an hourly tick, tolerant of drift

export async function runAutoSync(): Promise<{ due: number; synced: number; failed: number }> {
  const due = await db.bankConnection.findMany({
    where: {
      status: "active",
      tokenEnc: { not: "" },
      OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: new Date(Date.now() - STALE_MS) } }],
    },
  });
  let synced = 0;
  let failed = 0;
  for (const c of due) {
    try {
      if (c.provider === "enablebanking") await syncEnableBanking(c.userId);
      else if (c.provider === "zenmoney") await syncZenMoney(c.userId);
      else continue;
      synced++;
    } catch {
      failed++;
    }
  }
  if (due.length) logEvent("auto_sync", undefined, { due: due.length, synced, failed });
  return { due: due.length, synced, failed };
}
