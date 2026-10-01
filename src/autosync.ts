import { db, logEvent } from "./db";
import { syncEnableBanking } from "./enablebanking/sync";
import { syncZenMoney } from "./zenmoney/sync";
import { asBaseWriter } from "./baseGate";

// Server-side daily pull for every healthy bank connection, so transactions
// arrive without the user asking. The hourly tick picks up whatever became
// stale; sync functions persist status/lastError on failure. Only a failure
// the user must fix (rejected ZenMoney token, ended bank consent) flips the
// connection to "error", which drops it from this list until they reconnect;
// anything else stays "active" and is retried.
const STALE_MS = 20 * 60 * 60 * 1000; // ~daily with an hourly tick, tolerant of drift
// A failed Enable Banking pull is retried unattended only after this pause:
// banks allow about 4 background accesses a day (PSD2) and EB advises 6 hours
// after a rate limit. The failure write bumps updatedAt, so lastError plus a
// recent updatedAt means "failed recently". ZenMoney has no such quota.
const EB_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

export async function runAutoSync(
  onlyUserId?: string
): Promise<{ due: number; synced: number; failed: number; backoff: number }> {
  // onlyUserId scopes the run to one user (e2e: the suite shares a database
  // with real users and must never poke their live bank connections).
  const stale = await db.bankConnection.findMany({
    where: {
      ...(onlyUserId ? { userId: onlyUserId } : {}),
      status: "active",
      tokenEnc: { not: "" },
      OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: new Date(Date.now() - STALE_MS) } }],
    },
  });
  const retryAfter = Date.now() - EB_RETRY_AFTER_MS;
  const due = stale.filter(
    (c) => !(c.provider === "enablebanking" && c.lastError && c.updatedAt.getTime() > retryAfter)
  );
  const backoff = stale.length - due.length;
  let synced = 0;
  let failed = 0;
  for (const c of due) {
    try {
      // Through the base-switch gate like the sync tools: a base change waits
      // for this sync, and a sync never prices rows in a base being replaced.
      if (c.provider === "enablebanking") await asBaseWriter(c.userId, () => syncEnableBanking(c.userId));
      else if (c.provider === "zenmoney") await asBaseWriter(c.userId, () => syncZenMoney(c.userId));
      else continue;
      synced++;
    } catch {
      failed++; // the sync already recorded lastError (and status, if the user must act)
    }
  }
  if (stale.length) logEvent("auto_sync", undefined, { due: due.length, synced, failed, backoff });
  return { due: due.length, synced, failed, backoff };
}
