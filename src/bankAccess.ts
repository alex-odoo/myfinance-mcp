import { db } from "./db";
import { config } from "./config";
import { ebConfigured } from "./enablebanking/client";

/**
 * Whether an account is offered direct bank sync (connect_bank, sync_bank).
 * The Enable Banking app is in a restricted tier: a new user can start a
 * consent but the bank shares no accounts, and every user who began there
 * left. So the tools are listed only for BANK_SYNC_EMAILS and for accounts
 * that hold a working (active) bank connection. The MCP server is built per request,
 * so the answer is cached for a few minutes.
 */
const CACHE_MS = 5 * 60 * 1000;
const MAX_CACHED = 10_000;
const cache = new Map<string, { offered: boolean; at: number }>();

export async function bankSyncOffered(userId: string): Promise<boolean> {
  if (!ebConfigured()) return false;
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.offered;
  const user = await db.user.findUnique({
    where: { id: userId },
    // Active only: a failed or abandoned consent leaves its row behind in
    // "error", and that must not keep the dead end open.
    select: {
      email: true,
      bankConnections: { where: { provider: "enablebanking", status: "active" }, select: { id: true }, take: 1 },
    },
  });
  const offered = !!user && (config.bankSyncEmails.includes(user.email.toLowerCase()) || user.bankConnections.length > 0);
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(userId, { offered, at: Date.now() });
  return offered;
}
