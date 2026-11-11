import { db, logEvent } from "./db";
import { mailConfigured, sendMail } from "./mail";
import type { BankConnection } from "./generated/prisma/client";
import type { EbConnectionMeta } from "./enablebanking/sync";

const DAY = 86_400_000;
/**
 * A bank consent's last week: the read tools warn, one email goes out, and
 * bank action=start may renew the consent without a disconnect first.
 */
export const CONSENT_WARN_MS = 7 * DAY;
/** A sync failing for this long (or never once succeeding) is worth telling the user. */
const FAILING_FOR_MS = 2 * DAY;
/** An authorization link lives 30 minutes: a connection still pending after that was abandoned. */
export const PENDING_DEAD_MS = 30 * 60_000;

/**
 * A bank approval that may still complete: its link lives 30 minutes from
 * meta.startedAt; a row without a start time counts as in progress. The read
 * tools and these notices share it, so they never disagree about one row.
 */
export function approvalInProgress(meta: unknown, now = Date.now()): boolean {
  const startedAt = ((meta ?? {}) as EbConnectionMeta).startedAt;
  return !startedAt || now - startedAt <= PENDING_DEAD_MS;
}

export interface BankNotice {
  source: string;
  problem: "reconnect_needed" | "consent_ending" | "sync_failing";
  last_sync: string | null;
  ends_on?: string;
  detail?: string;
  action: string;
}

/** The columns the notices read: never tokens or account maps. */
const NOTICE_FIELDS = {
  provider: true,
  status: true,
  meta: true,
  lastSyncAt: true,
  lastError: true,
  lastFailedAt: true,
} as const;
type NoticeRow = Pick<BankConnection, keyof typeof NOTICE_FIELDS>;

const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
const metaOf = (c: Pick<BankConnection, "meta">) => (c.meta ?? {}) as EbConnectionMeta;

function sourceName(c: Pick<BankConnection, "provider" | "meta">): string {
  return c.provider === "zenmoney" ? "ZenMoney" : (metaOf(c).aspsp?.name ?? "the bank");
}

/**
 * Where an active Enable Banking link's consent stands: "ending" within
 * CONSENT_WARN_MS, "ended" already (the row stays active until the next sync
 * notices, up to a day later), undefined otherwise. Both may be renewed.
 */
export function consentPhase(
  c: Pick<BankConnection, "provider" | "status" | "meta">,
  now = Date.now()
): "ending" | "ended" | undefined {
  const until = metaOf(c).validUntil;
  if (c.provider !== "enablebanking" || c.status !== "active" || !until) return undefined;
  const ends = Date.parse(until);
  if (ends <= now) return "ended";
  return ends - now <= CONSENT_WARN_MS ? "ending" : undefined;
}

/** The arguments bank action=start needs for this link's bank, as the client should pass them. */
function startArgs(c: Pick<BankConnection, "meta">): string {
  const aspsp = metaOf(c).aspsp;
  return aspsp
    ? `bank action=start with bank_name "${aspsp.name}" and country "${aspsp.country}"`
    : "bank action=start for the user's bank (bank action=list_banks gives its exact name)";
}

function reconnectAction(c: Pick<BankConnection, "provider" | "meta">): string {
  if (c.provider === "zenmoney") {
    return "Offer to reconnect: the user gets a fresh token at zerro.app/token and you store it with zenmoney action=paste_token.";
  }
  return `Offer to reconnect: ${startArgs(c)}; the user approves in their bank's app, and the next sync fills the gap.`;
}

/**
 * Bank links the user must hear about, for the read tools to carry: data
 * stops arriving without a word otherwise, and the client model blames a
 * missing statement. Empty when every link is healthy. Every link listed
 * here is active or once synced, which is exactly who gets the bank tool
 * (bankAccess.ts), so the action never points at a tool the user lacks.
 */
export async function bankNotices(userId: string, now = Date.now()): Promise<BankNotice[]> {
  const conns: NoticeRow[] = await db.bankConnection.findMany({ where: { userId }, select: NOTICE_FIELDS });
  const out: BankNotice[] = [];
  for (const c of conns) {
    // A link that never synced and is not active was abandoned or declined
    // at the bank (cancelled, no accounts shared): no reminder about it.
    if (c.status !== "active" && !c.lastSyncAt) continue;
    const source = sourceName(c);
    const lastSync = c.lastSyncAt ? c.lastSyncAt.toISOString() : null;
    const since = c.lastSyncAt ? ` since ${day(c.lastSyncAt)}` : "";
    const phase = consentPhase(c, now);
    if (phase === "ended") {
      const ended = day(metaOf(c).validUntil!);
      out.push({
        source,
        problem: "reconnect_needed",
        last_sync: lastSync,
        detail: `Bank consent expired on ${ended}.`,
        action: `Tell the user that the access they approved at ${source} ended on ${ended}, so nothing new arrives from it. Offer to renew it: ${startArgs(c)} (no disconnect needed); they approve in their bank's app, and the next sync fills the gap.`,
      });
    } else if (c.status === "error") {
      out.push({
        source,
        problem: "reconnect_needed",
        last_sync: lastSync,
        ...(c.lastError ? { detail: c.lastError } : {}),
        action: `Tell the user that ${source} stopped syncing${since} and nothing new arrives from it until they reconnect. ${reconnectAction(c)}`,
      });
    } else if (c.status === "pending") {
      if (approvalInProgress(c.meta, now)) continue; // a link in progress
      out.push({
        source,
        problem: "reconnect_needed",
        last_sync: lastSync,
        detail: "The bank authorization was started but never finished.",
        action: `Tell the user that ${source} is not syncing${since}: the bank approval was never completed. ${reconnectAction(c)}`,
      });
    } else if (phase === "ending") {
      const ends = day(metaOf(c).validUntil!);
      out.push({
        source,
        problem: "consent_ending",
        last_sync: lastSync,
        ends_on: ends,
        action: `Tell the user that the access they approved at ${source} ends on ${ends} and syncing stops then. Offer to renew it now: ${startArgs(c)} (allowed in the consent's last 7 days, no disconnect needed; the current access keeps working until they approve); they approve in their bank's app.`,
      });
    } else if (
      c.lastFailedAt &&
      (!c.lastSyncAt || (c.lastFailedAt > c.lastSyncAt && now - c.lastSyncAt.getTime() > FAILING_FOR_MS))
    ) {
      // A failure after the last success, for days (or before any success).
      // lastError alone is not a failure: a successful sync notes skipped rows there.
      out.push({
        source,
        problem: "sync_failing",
        last_sync: lastSync,
        ...(c.lastError ? { detail: c.lastError } : {}),
        action: `Tell the user that syncing ${source} is failing${since || " and has never completed"}, quoting the detail; data from it may be missing.`,
      });
    }
  }
  return out;
}

/**
 * `{ bank_notice }` for a read tool's payload, or nothing when all links are
 * healthy. Never fails the tool: a notice that cannot be read is left out.
 */
export function bankNoticeField(userId: string): Promise<{ bank_notice?: BankNotice[] }> {
  return bankNotices(userId).then(
    (notices) => (notices.length ? { bank_notice: notices } : {}),
    () => ({})
  );
}

/**
 * One email per consent, in its last week: the user renews before syncing
 * stops instead of finding a month of missing data later. Claimed on the row
 * before sending (optimistic on updatedAt), so a second tick never sends
 * twice; a new consent brings a new validUntil and a fresh reminder. One
 * attempt per consent: a failed send is not retried (the read tools still
 * carry the notice), so a mail outage never turns into an hourly loop.
 * Transactional, about a link the user made: no opt-in needed, no amounts.
 */
export async function remindBankConsents(onlyUserId?: string, now = Date.now()): Promise<number> {
  if (!mailConfigured()) return 0;
  const conns = await db.bankConnection.findMany({
    where: { provider: "enablebanking", status: "active", tokenEnc: { not: "" }, ...(onlyUserId ? { userId: onlyUserId } : {}) },
    select: { id: true, userId: true, provider: true, status: true, meta: true, updatedAt: true, user: { select: { email: true } } },
  });
  let sent = 0;
  for (const c of conns) {
    const meta = metaOf(c);
    // Not while a renewal is in progress (its link lives 30 minutes): the
    // bank's return page rewrites this meta from its own read. An abandoned
    // one, never opened, leaves its state behind and must not block the email.
    const renewing = !!meta.state && !!meta.startedAt && now - meta.startedAt <= PENDING_DEAD_MS;
    if (consentPhase(c, now) !== "ending" || meta.consentReminded === meta.validUntil || renewing) continue;
    const claimed = await db.bankConnection.updateMany({
      where: { id: c.id, updatedAt: c.updatedAt },
      data: { meta: { ...(c.meta as object), consentReminded: meta.validUntil } },
    });
    if (claimed.count !== 1) continue; // changed under us: the next tick looks again
    const bank = sourceName(c);
    const ends = day(meta.validUntil!);
    const ok = await sendMail(
      c.user.email,
      `${bank} sync stops on ${ends}`,
      [
        "Hello,",
        "",
        `The read-only access you approved at ${bank} for MyFinance MCP ends on ${ends}. Banks limit this access by law (PSD2), so it has to be renewed from time to time.`,
        "",
        `To keep your transactions arriving, ask your AI assistant: "Renew my bank connection in MyFinance". It gives you a link; approve it in your bank's app. It takes a minute, and nothing you imported is lost.`,
        "",
        `If you do nothing, syncing stops on ${ends}. Your records stay.`,
        "",
        "MyFinance MCP",
        "https://myfinance-mcp.com",
      ].join("\n")
    );
    logEvent("consent_reminded", c.userId, { provider: c.provider, sent: ok });
    if (ok) sent++;
  }
  return sent;
}
