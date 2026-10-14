import { createHmac, timingSafeEqual } from "node:crypto";
import { db, logEvent } from "./db";
import { config } from "./config";
import { round2 } from "./fx";
import { mailConfigured, sendMail } from "./mail";

/**
 * Email summaries: the one channel that reaches a user outside the chat (an
 * MCP server cannot speak first). Opt-in only, through update_settings after
 * the user said yes. Weekly ones cover Monday to Sunday and go out on Monday,
 * monthly ones cover the calendar month and go out on the 1st, both from
 * 08:00 in the user's timezone. A period is claimed in the database before
 * its email is sent, so two ticks never send it twice.
 */

export const DIGEST_CHOICES = ["off", "weekly", "monthly"] as const;
export type DigestChoice = (typeof DIGEST_CHOICES)[number];
type Kind = "weekly" | "monthly";

const SEND_HOUR = 8;
// The Resend account's free tier allows 100 emails a UTC day, sign-in codes
// included: summaries stop at 60 a day so sign-in never runs out, and the
// rest go out on the next ticks (a period stays due until it is sent).
const DAILY_CAP = 60;
const MAX_PER_TICK = 30;
const TOP_CATEGORIES = 6;
const DAY_MS = 86_400_000;
// A user who imports statements is reminded when the last import is older than this.
const IMPORT_REMINDER_DAYS = 25;

export function digestAvailable(): boolean {
  return mailConfigured() && !!config.tokenEncKey;
}

// ---- dates in the user's timezone (rows are stored as UTC midnight of the local day)

function localNow(now: Date, timezone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(day(s).getTime() + n * DAY_MS));

interface Period {
  key: string;
  start: Date;
  end: Date;
  label: string;
  /** First local day after the period: the email goes out from 08:00 that day. */
  boundary: string;
}

/** The last complete week or month before the local date `today`. */
function lastComplete(kind: Kind, today: string): Period {
  if (kind === "monthly") {
    const [y, m] = today.split("-").map(Number) as [number, number];
    const boundary = `${y}-${String(m).padStart(2, "0")}-01`;
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    const key = `${py}-${String(pm).padStart(2, "0")}`;
    const label = new Date(`${key}-01T00:00:00.000Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    return { key, start: day(`${key}-01`), end: day(boundary), label, boundary };
  }
  const weekday = (day(today).getUTCDay() + 6) % 7; // Monday = 0
  const boundary = addDays(today, -weekday); // Monday of this week
  const startDay = addDays(boundary, -7);
  return {
    key: `${startDay}/w`,
    start: day(startDay),
    end: day(boundary),
    label: `the week of ${day(startDay).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`,
    boundary,
  };
}

/** The period of the same kind just before `p`. */
function before(kind: Kind, p: Period): { start: Date; end: Date } {
  if (kind === "weekly") return { start: new Date(p.start.getTime() - 7 * DAY_MS), end: p.start };
  const [y, m] = p.key.split("-").map(Number) as [number, number];
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  return { start: day(`${prev}-01`), end: p.start };
}

// ---- unsubscribe links

function unsubscribeToken(userId: string): string {
  const key = createHmac("sha256", config.tokenEncKey).update("myfinance digest unsubscribe v1").digest();
  return createHmac("sha256", key).update(userId).digest("base64url");
}

export function unsubscribeUrl(userId: string): string {
  return `${config.baseUrl}/digest/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubscribeToken(userId)}`;
}

export function validUnsubscribe(userId: string, token: string): boolean {
  if (!config.tokenEncKey || !/^[0-9a-f-]{36}$/i.test(userId)) return false;
  const want = Buffer.from(unsubscribeToken(userId));
  const got = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

// ---- content

const fmt = (n: number, currency: string) =>
  `${n.toLocaleString("en-US", { useGrouping: true, minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${currency}`;
const label = (category: string) => category.charAt(0).toUpperCase() + category.slice(1).replace(/_/g, " ");

interface DigestUser {
  id: string;
  email: string;
  baseCurrency: string;
  timezone: string;
}

async function spending(userId: string, start: Date, end: Date) {
  const rows = await db.transaction.groupBy({
    by: ["type", "categoryKey"],
    where: { userId, occurredAt: { gte: start, lt: end }, type: { not: "transfer" } },
    _sum: { amountBase: true },
    _count: { _all: true },
  });
  const byCategory = new Map<string, number>();
  let expense = 0;
  let income = 0;
  let records = 0;
  for (const r of rows) {
    const sum = Number(r._sum.amountBase ?? 0);
    records += r._count._all;
    if (r.type === "income") income += sum;
    else {
      expense += sum;
      const k = r.categoryKey ?? "other";
      byCategory.set(k, (byCategory.get(k) ?? 0) + sum);
    }
  }
  return { expense: round2(expense), income: round2(income), records, byCategory };
}

/** The email for one period, or null when there is nothing worth sending. */
export async function buildDigest(
  user: DigestUser,
  kind: Kind | "welcome",
  period: { start: Date; end: Date; label: string },
  previous: { start: Date; end: Date } | null
): Promise<{ subject: string; text: string } | null> {
  const cur = user.baseCurrency;
  const now = await spending(user.id, period.start, period.end);
  if (now.records === 0 && kind === "weekly") return null; // a quiet week needs no email
  const prev = previous ? await spending(user.id, previous.start, previous.end) : null;
  const lines: string[] = [];

  if (now.records === 0) {
    lines.push(`Nothing was logged for ${period.label}.`);
  } else {
    const change =
      prev && prev.expense > 0 ? ` (${now.expense >= prev.expense ? "+" : ""}${Math.round(((now.expense - prev.expense) / prev.expense) * 100)}% vs the period before)` : "";
    lines.push(`Spent: ${fmt(now.expense, cur)}${change}`);
    if (now.income > 0) lines.push(`Income: ${fmt(now.income, cur)}`, `Net: ${fmt(round2(now.income - now.expense), cur)}`);
    const top = [...now.byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_CATEGORIES);
    if (top.length) {
      lines.push("", "Where it went:");
      for (const [k, v] of top) {
        const before = prev?.byCategory.get(k);
        const delta = before && before > 0 ? `, ${v >= before ? "+" : ""}${Math.round(((v - before) / before) * 100)}%` : "";
        lines.push(`- ${label(k)}: ${fmt(round2(v), cur)} (${Math.round((v / now.expense) * 100)}%${delta})`);
      }
    }
  }

  // Budgets are monthly: the monthly email and the welcome (month so far) show them.
  if (kind !== "weekly") {
    const budgets = await db.budget.findMany({ where: { userId: user.id } });
    if (budgets.length) {
      const personal = await db.transaction.groupBy({
        by: ["categoryKey"],
        where: { userId: user.id, type: "expense", entity: "personal", occurredAt: { gte: period.start, lt: period.end } },
        _sum: { amountBase: true },
      });
      const spent = new Map(personal.map((r) => [r.categoryKey ?? "other", Number(r._sum.amountBase ?? 0)]));
      const total = [...spent.values()].reduce((a, b) => a + b, 0);
      lines.push("", "Budgets:");
      for (const b of budgets) {
        const used = b.categoryKey === "overall" ? total : (spent.get(b.categoryKey) ?? 0);
        const cap = Number(b.amount);
        const state = used > cap ? `over by ${fmt(round2(used - cap), cur)}` : `${fmt(round2(cap - used), cur)} left`;
        lines.push(`- ${b.categoryKey === "overall" ? "Whole month" : label(b.categoryKey)}: ${fmt(round2(used), cur)} of ${fmt(cap, cur)}, ${state}`);
      }
    }
  }

  // People who import statements by hand get a nudge when the last import is
  // old. Rows pulled by a bank or ZenMoney sync carry their provider prefix,
  // and a live connection needs no reminder.
  const [lastImport, liveConnections] = await Promise.all([
    db.transaction.findFirst({
      where: {
        userId: user.id,
        source: "bank",
        NOT: [{ externalId: { startsWith: "eb:" } }, { externalId: { startsWith: "zenmoney:" } }],
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    db.bankConnection.count({ where: { userId: user.id, status: "active" } }),
  ]);
  if (!liveConnections && lastImport && Date.now() - lastImport.createdAt.getTime() > IMPORT_REMINDER_DAYS * DAY_MS) {
    lines.push("", "Your last statement import was a while ago: export the latest statement from your bank and drop it into your AI chat.");
  } else if (now.records === 0) {
    lines.push("", "Tell your AI what you spend, or drop a bank statement into the chat, and the next summary will have numbers.");
  }

  lines.push(
    "",
    "Ask your AI for details any time, e.g. \"how much did I spend on groceries this month?\".",
    "",
    "--",
    "You get this because you asked your AI to turn on the MyFinance email summary.",
    `Stop it: ${unsubscribeUrl(user.id)}`,
    "Or say \"turn off the MyFinance email summary\" in your AI chat."
  );

  const headline = now.records === 0 ? "nothing logged" : `${fmt(now.expense, cur)} spent`;
  const subject =
    kind === "welcome"
      ? `MyFinance email summary is on: ${period.label} so far`
      : `Your ${period.label} with MyFinance: ${headline}`;
  const intro =
    kind === "welcome"
      ? `Your email summary is on. Here is ${period.label} so far; the next one comes on schedule.`
      : `Your summary for ${period.label}.`;
  return { subject, text: [intro, "", ...lines].join("\n") };
}

/** Summaries (and confirmations) still allowed today under DAILY_CAP. */
async function roomToday(now = new Date()): Promise<number> {
  const startOfDay = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const sent = await db.event.count({ where: { type: "digest_sent", createdAt: { gte: startOfDay } } });
  return Math.max(0, DAILY_CAP - sent);
}

async function send(user: DigestUser, mail: { subject: string; text: string }): Promise<boolean> {
  const url = unsubscribeUrl(user.id);
  return sendMail(user.email, mail.subject, mail.text, {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  });
}

/**
 * The period a new subscription starts after: the last complete one is
 * marked as sent, so turning the summary on never mails an old period.
 */
export function startingPoint(kind: Kind, timezone: string, now = new Date()): string {
  return lastComplete(kind, localNow(now, timezone).date).key;
}

/** The confirmation email of a new subscription: the current month so far. */
export async function sendWelcome(user: DigestUser, now = new Date()): Promise<boolean> {
  if ((await roomToday(now)) === 0) return false;
  const today = localNow(now, user.timezone).date;
  const start = day(`${today.slice(0, 7)}-01`);
  const end = new Date(day(today).getTime() + DAY_MS);
  const label = start.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const mail = await buildDigest(user, "welcome", { start, end, label }, null);
  const ok = !!mail && (await send(user, mail));
  logEvent(ok ? "digest_sent" : "digest_failed", user.id, { kind: "welcome" });
  return ok;
}

/** One scheduler tick: send every summary that is due. onlyUserId scopes a test run. */
export async function runDigests(now = new Date(), onlyUserId?: string) {
  const result = { due: 0, sent: 0, skipped: 0, failed: 0 };
  if (!digestAvailable()) return result;
  const users = await db.user.findMany({
    where: { digest: { in: ["weekly", "monthly"] }, ...(onlyUserId ? { id: onlyUserId } : {}) },
    select: { id: true, email: true, baseCurrency: true, timezone: true, digest: true, digestSentFor: true },
  });
  const budget = Math.min(MAX_PER_TICK, await roomToday(now));
  for (const u of users) {
    if (result.sent + result.failed >= budget) break;
    const kind = u.digest as Kind;
    let claimed: string | null = null;
    // Everything per user inside the try: one bad row (a timezone the
    // runtime rejects, a database blip) must not stop the others.
    try {
      const local = localNow(now, u.timezone);
      const period = lastComplete(kind, local.date);
      if (u.digestSentFor === period.key) continue;
      if (local.date === period.boundary && local.hour < SEND_HOUR) continue;
      result.due++;
      // Claim the period first: a second tick (or instance) finds it taken.
      const { count } = await db.user.updateMany({
        where: { id: u.id, digest: kind, digestSentFor: u.digestSentFor },
        data: { digestSentFor: period.key },
      });
      if (count !== 1) continue;
      claimed = period.key;
      const mail = await buildDigest(u, kind, period, before(kind, period));
      if (!mail) {
        result.skipped++;
        continue;
      }
      if (await send(u, mail)) {
        result.sent++;
        logEvent("digest_sent", u.id, { kind });
      } else {
        throw new Error("send failed");
      }
    } catch (e) {
      result.failed++;
      logEvent("digest_failed", u.id, { kind });
      console.error(`[digest] ${kind} failed:`, e instanceof Error ? e.message : String(e));
      // Release the claim so the next tick retries this period.
      if (claimed) {
        await db.user
          .updateMany({ where: { id: u.id, digestSentFor: claimed }, data: { digestSentFor: u.digestSentFor } })
          .catch(() => {});
      }
    }
  }
  return result;
}

/** The unsubscribe link's work: turn the summary off. */
export async function unsubscribe(userId: string): Promise<boolean> {
  const { count } = await db.user.updateMany({ where: { id: userId }, data: { digest: "off" } });
  if (count) logEvent("digest_unsubscribed", userId, {});
  return count === 1;
}
