import { db } from "./db";
import { config } from "./config";
import { ebConfigured } from "./enablebanking/client";

/**
 * Whether an account is offered direct bank sync (connect_bank, sync_bank).
 * The Enable Banking app is in a restricted tier: a new user can start a
 * consent but the bank shares no accounts, and every user who began there
 * left. So the tools are listed only for BANK_SYNC_EMAILS and for accounts
 * whose bank connection is active or has synced before. The MCP server is built per request,
 * so the answer is cached for a few minutes.
 */
const CACHE_MS = 5 * 60 * 1000;
const MAX_CACHED = 10_000;
const cache = new Map<string, { offered: boolean; at: number }>();

export async function bankSyncOffered(userId: string): Promise<boolean> {
  if (!ebConfigured()) return false;
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.offered;
  try {
    return await lookup(userId);
  } catch (e) {
    // A database blip must not fail the whole MCP request: keep the last
    // answer, or leave the bank tools out for this one request.
    console.error("[bank] access check failed:", e instanceof Error ? e.message : String(e));
    return hit?.offered ?? false;
  }
}

async function lookup(userId: string): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    // A connection that is active or has synced at least once: its consent
    // can expire and must stay renewable. A first attempt that failed leaves
    // a row in "error" that never synced, and that must not keep the dead
    // end open.
    select: {
      email: true,
      bankConnections: {
        where: { provider: "enablebanking", OR: [{ status: "active" }, { lastSyncAt: { not: null } }] },
        select: { id: true },
        take: 1,
      },
    },
  });
  const offered = !!user && (config.bankSyncEmails.includes(user.email.toLowerCase()) || user.bankConnections.length > 0);
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(userId, { offered, at: Date.now() });
  return offered;
}
