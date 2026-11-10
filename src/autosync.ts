import { db, logEvent } from "./db";
import { syncEnableBanking } from "./enablebanking/sync";
import { syncZenMoney } from "./zenmoney/sync";
import { asBaseWriter } from "./baseGate";
import { remindBankConsents } from "./bankNotice";

// Server-side daily pull for every healthy bank connection, so transactions
// arrive without the user asking. The hourly tick picks up whatever became
// stale; sync functions persist status/lastError on failure. Only a failure
// the user must fix (rejected ZenMoney token, ended bank consent) flips the
// connection to "error", which drops it from this list until they reconnect;
// anything else stays "active" and is retried.
const STALE_MS = 20 * 60 * 60 * 1000; // ~daily with an hourly tick, tolerant of drift
// A failed pull is retried unattended only after this pause. Enable Banking:
// banks allow about 4 background accesses a day (PSD2) and EB advises 6 hours
// after a rate limit. ZenMoney has no quota, but a sync that keeps failing on
// its first run re-downloads the whole history: hourly, that once ran for days.
// lastFailedAt is written only by a failing sync (updatedAt moves on any
// write); a manual sync always runs.
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

export async function runAutoSync(
  onlyUserId?: string
): Promise<{ due: number; synced: number; failed: number; backoff: number; reminded: number }> {
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
  const retryAfter = Date.now() - RETRY_AFTER_MS;
  const due = stale.filter((c) => !(c.lastFailedAt && c.lastFailedAt.getTime() > retryAfter));
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
  // After the syncs, never alongside them: a consent's last-week email.
  const reminded = await remindBankConsents(onlyUserId).catch((e: unknown) => {
    console.error("[autosync] consent reminders failed:", e instanceof Error ? e.message : String(e));
    return 0;
  });
  return { due: due.length, synced, failed, backoff, reminded };
}
