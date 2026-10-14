import { db, logEvent } from "./db";
import { convert, round2 } from "./fx";
import { resolveAccount } from "./accounts";
import { asBaseWriter } from "./baseGate";

/**
 * Recurring payments: subscriptions, rent, bills. Two kinds reach the user:
 * the ones they saved (RecurringPayment, through set_recurring) and the ones
 * found in their rows here, which are suggestions until saved.
 *
 * Found = an expense series at one merchant in one currency that repeats on
 * a cadence (weekly, monthly, quarterly, yearly) at a steady amount, or a
 * single recent charge from a known subscription service (a one-month
 * statement shows each subscription once). Everyday spending (groceries,
 * cafes, fuel) is never a recurring payment, whatever its rhythm.
 */

export const CADENCES = ["weekly", "monthly", "quarterly", "yearly"] as const;
export type Cadence = (typeof CADENCES)[number];

interface CadenceRule {
  /** Gap between two charges, in days, that counts as one period. */
  min: number;
  max: number;
  /** Periods per month, for the monthly cost. */
  perMonth: number;
  /** Days past the expected date before a series counts as stopped. */
  grace: number;
}

const RULES: Record<Cadence, CadenceRule> = {
  weekly: { min: 6, max: 8, perMonth: 52 / 12, grace: 4 },
  monthly: { min: 26, max: 35, perMonth: 1, grace: 10 },
  quarterly: { min: 84, max: 98, perMonth: 1 / 3, grace: 20 },
  yearly: { min: 350, max: 380, perMonth: 1 / 12, grace: 30 },
};

const DAY_MS = 86_400_000;
const LOOKBACK_DAYS = 400;
const MAX_ROWS = 20_000;
/** A single charge from a subscription service counts if it is this recent. */
const SINGLE_CHARGE_DAYS = 45;
const MAX_FOUND = 50;
/** How far ahead get_recurring and the email look for what is coming up. */
export const UPCOMING_DAYS = 30;
/** Auto-logging catches up at most this many missed dates per payment and run. */
const MAX_CATCH_UP = 12;
export const AUTO_LOG_NOTE = "Logged automatically: recurring payment";

// Spending that repeats by habit, not by contract.
const EVERYDAY = new Set(["groceries", "restaurants", "fuel", "clothing", "personal_care", "pharmacy", "gifts", "travel"]);
// Bills whose amount moves with use: a wider tolerance.
const VARIABLE_BILLS = new Set(["housing", "utilities"]);

// Merchant words of subscription services: one charge from them is enough to
// suggest it. Matched as substrings of the normalized merchant.
const SUBSCRIPTION_SERVICES = [
  "netflix", "spotify", "youtube", "apple.com/bill", "itunes", "icloud", "google one", "google storage", "google play",
  "disney", "hbo", "amazon prime", "prime video", "audible", "kindle unlimited", "microsoft", "xbox", "playstation",
  "nintendo", "adobe", "canva", "notion", "figma", "github", "openai", "chatgpt", "anthropic", "claude.ai", "midjourney",
  "dropbox", "zoom.us", "slack", "linkedin", "duolingo", "patreon", "twitch", "deezer", "tidal", "yandex plus",
  "яндекс плюс", "кинопоиск", "okko", "ivi", "wink", "megogo", "sweet.tv", "1password", "nordvpn", "expressvpn",
  "proton", "grammarly", "cursor", "jetbrains", "mubi", "crunchyroll", "paramount", "hulu", "peacock", "dazn",
  "strava", "headspace", "calm.com", "tinder", "bumble",
];

/** A merchant string reduced to what stays the same across charges: no store numbers, references or dates. */
export function merchantKey(merchant: string): string {
  return merchant
    .toLowerCase()
    .replace(/\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?/g, " ")
    .replace(/\d{3,}/g, " ")
    .replace(/[*#_|]/g, " ")
    .replace(/[^\p{L}\p{N} .&+/-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const isSubscriptionService = (key: string) => SUBSCRIPTION_SERVICES.some((s) => key.includes(s));

// ---- dates (rows are stored as UTC midnight of the user's local day)

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((day(b).getTime() - day(a).getTime()) / DAY_MS);

export function localToday(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
}

/** The charge after `date`: a week on, or the same day of the month (anchorDay) a cadence later. */
export function nextCharge(date: string, cadence: Cadence, anchorDay: number): string {
  if (cadence === "weekly") return iso(new Date(day(date).getTime() + 7 * DAY_MS));
  const months = cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : 12;
  const [y, m] = date.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(anchorDay, lastDay)).padStart(2, "0")}`;
}

/** The first charge on or after `today`, counting from a known one. */
export function rollForward(date: string, cadence: Cadence, anchorDay: number, today: string): string {
  let d = date;
  for (let i = 0; d < today && i < 2000; i++) d = nextCharge(d, cadence, anchorDay);
  return d;
}

// ---- finding them in the rows

export interface FoundPayment {
  name: string;
  cadence: Cadence;
  amount: number;
  currency: string;
  amount_varies: boolean;
  monthly_base: number;
  last_date: string;
  next_date: string;
  occurrences: number;
  status: "active" | "stopped";
  evidence: "repeats" | "subscription_service" | "subscription_category";
  category: string;
  key: string;
}

interface Row {
  merchant: string;
  amount: number;
  amountBase: number;
  date: string;
  category: string;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** Which cadence a run of charges keeps, if any: most gaps inside one period (a missed charge may double one). */
function cadenceOf(dates: string[]): Cadence | undefined {
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i]!, d));
  if (!gaps.length) return undefined;
  for (const cadence of CADENCES) {
    const { min, max } = RULES[cadence];
    const fits = gaps.filter((g) => (g >= min && g <= max) || (g >= 2 * min && g <= 2 * max)).length;
    const exact = gaps.filter((g) => g >= min && g <= max).length;
    if (exact >= 1 && fits / gaps.length >= 0.75) return cadence;
  }
  return undefined;
}

/** One series (same merchant, currency and, when split, amount) as a found payment, or undefined. */
function asPayment(key: string, currency: string, rows: Row[], today: string): FoundPayment | undefined {
  // Several charges on one day are one charge here (a double entry, or a split).
  const byDay = new Map<string, Row>();
  for (const r of rows) if (!byDay.has(r.date)) byDay.set(r.date, r);
  const series = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  const last = series[series.length - 1]!;
  const category = last.category;
  if (EVERYDAY.has(category)) return undefined;
  const amounts = series.map((r) => r.amount);
  const typical = median(amounts);
  if (typical <= 0) return undefined;
  const spread = Math.max(...amounts.map((a) => Math.abs(a - typical) / typical));
  const base = median(series.map((r) => r.amountBase));

  let cadence: Cadence | undefined;
  let evidence: FoundPayment["evidence"];
  if (series.length >= 2) {
    cadence = cadenceOf(series.map((r) => r.date));
    if (!cadence) return undefined;
    if (spread > (VARIABLE_BILLS.has(category) ? 0.35 : 0.1)) return undefined;
    evidence = "repeats";
  } else {
    if (daysBetween(last.date, today) > SINGLE_CHARGE_DAYS) return undefined;
    if (isSubscriptionService(key)) evidence = "subscription_service";
    else if (category === "subscriptions") evidence = "subscription_category";
    else return undefined;
    cadence = "monthly";
  }
  const anchor = Number(last.date.slice(8, 10));
  const next = nextCharge(last.date, cadence, anchor);
  const stopped = daysBetween(next, today) > RULES[cadence].grace;
  return {
    name: last.merchant.trim().slice(0, 60),
    cadence,
    amount: round2(typical),
    currency,
    amount_varies: spread > 0.02,
    monthly_base: round2(base * RULES[cadence].perMonth),
    last_date: last.date,
    next_date: stopped ? next : rollForward(next, cadence, anchor, today),
    occurrences: series.length,
    status: stopped ? "stopped" : "active",
    evidence,
    category,
    key,
  };
}

/** Recurring payments found in the user's expenses of the last ~13 months, biggest monthly cost first. */
export async function findRecurring(userId: string, today: string): Promise<FoundPayment[]> {
  const rows = await db.transaction.findMany({
    where: {
      userId,
      type: "expense",
      amount: { gt: 0 },
      merchant: { not: null },
      occurredAt: { gte: new Date(day(today).getTime() - LOOKBACK_DAYS * DAY_MS) },
    },
    select: { merchant: true, amount: true, amountBase: true, currency: true, occurredAt: true, categoryKey: true },
    orderBy: { occurredAt: "desc" },
    take: MAX_ROWS,
  });
  const groups = new Map<string, { key: string; currency: string; rows: Row[] }>();
  for (const r of rows) {
    const key = merchantKey(r.merchant ?? "");
    if (key.length < 2) continue;
    const id = `${key}\u0000${r.currency}`;
    const g = groups.get(id) ?? { key, currency: r.currency, rows: [] };
    g.rows.push({
      merchant: r.merchant ?? "",
      amount: Number(r.amount),
      amountBase: Number(r.amountBase),
      date: iso(r.occurredAt),
      category: r.categoryKey ?? "other",
    });
    groups.set(id, g);
  }
  const found: FoundPayment[] = [];
  for (const g of groups.values()) {
    // Different amounts on one day are different payments (two Apple
    // subscriptions billed together): only the split below can see them.
    const amountsByDay = new Map<string, Set<number>>();
    for (const r of g.rows) amountsByDay.set(r.date, (amountsByDay.get(r.date) ?? new Set()).add(r.amount));
    const mixedDays = [...amountsByDay.values()].some((amounts) => amounts.size > 1);
    const whole = mixedDays ? undefined : asPayment(g.key, g.currency, g.rows, today);
    if (whole) {
      found.push(whole);
      continue;
    }
    // One merchant can bill several subscriptions at fixed prices (Apple,
    // Google): each exact amount is its own series.
    const byAmount = new Map<number, Row[]>();
    for (const r of g.rows) byAmount.set(r.amount, [...(byAmount.get(r.amount) ?? []), r]);
    if (byAmount.size < 2) continue;
    for (const [amount, rs] of byAmount) {
      if (rs.length < 2) continue;
      const p = asPayment(g.key, g.currency, rs, today);
      if (p) found.push({ ...p, key: `${g.key} ${amount}` });
    }
  }
  return found.sort((a, b) => b.monthly_base - a.monthly_base).slice(0, MAX_FOUND);
}

// ---- saved ones, and both together

export interface SavedView {
  name: string;
  amount: number;
  currency: string;
  cadence: Cadence;
  next_date: string;
  category: string;
  account?: string;
  auto_log: boolean;
  monthly_base: number | null;
}

/** Whether a found series is one the user already saved (same currency, names that contain each other). */
function sameAs(found: FoundPayment, saved: { name: string; currency: string }): boolean {
  if (found.currency !== saved.currency) return false;
  const a = merchantKey(saved.name);
  const b = found.key;
  return !!a && (a === b || (a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b)));
}

/** Everything get_recurring and the email show: saved, found (not saved), totals, coming up. */
export async function recurringOverview(
  user: { id: string; baseCurrency: string; timezone: string },
  now = new Date(),
  includeStopped = false
) {
  const today = localToday(user.timezone, now);
  const [savedRows, found] = await Promise.all([
    db.recurringPayment.findMany({ where: { userId: user.id }, include: { account: { select: { name: true } } }, orderBy: { name: "asc" } }),
    findRecurring(user.id, today),
  ]);
  const saved: SavedView[] = [];
  for (const r of savedRows) {
    const cadence = r.cadence as Cadence;
    const amount = Number(r.amount);
    let monthly: number | null = null;
    try {
      monthly = round2((await convert(amount, r.currency, user.baseCurrency, day(today))).converted * RULES[cadence].perMonth);
    } catch {
      monthly = null; // no rate today: the total says so
    }
    saved.push({
      name: r.name,
      amount,
      currency: r.currency,
      cadence,
      // Auto-logged ones are kept current by the scheduler; others roll here.
      next_date: rollForward(iso(r.nextDate), cadence, r.anchorDay, today),
      category: r.categoryKey,
      ...(r.account ? { account: r.account.name } : {}),
      auto_log: r.autoLog,
      monthly_base: monthly,
    });
  }
  const suggestions = found.filter((f) => !savedRows.some((s) => sameAs(f, s)) && (includeStopped || f.status === "active"));
  const active = [...saved.map((s) => s.monthly_base ?? 0), ...suggestions.filter((f) => f.status === "active").map((f) => f.monthly_base)];
  const monthly = round2(active.reduce((a, b) => a + b, 0));
  const horizon = iso(new Date(day(today).getTime() + UPCOMING_DAYS * DAY_MS));
  const upcoming = [
    ...saved.map((s) => ({ name: s.name, date: s.next_date, amount: s.amount, currency: s.currency, saved: true })),
    ...suggestions.filter((f) => f.status === "active").map((f) => ({ name: f.name, date: f.next_date, amount: f.amount, currency: f.currency, saved: false })),
  ]
    .filter((u) => u.date >= today && u.date <= horizon)
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    today,
    base_currency: user.baseCurrency,
    monthly_total: monthly,
    yearly_total: round2(monthly * 12),
    unpriced: saved.filter((s) => s.monthly_base === null).map((s) => s.name),
    saved,
    found: suggestions.map(({ key: _key, ...f }) => f),
    upcoming,
  };
}

// ---- writing them on their date

/**
 * One scheduler tick: every saved payment with auto_log whose date has come
 * (in the user's timezone) is written as an expense, and its next date set,
 * in one transaction: a second tick finds the date moved and writes nothing.
 * A charge already in the books (logged by hand or imported within 3 days,
 * same amount) only moves the date. A date the FX sources cannot price stays
 * due and is retried next tick. onlyUserId scopes a test run.
 */
export async function runRecurring(now = new Date(), onlyUserId?: string) {
  const result = { logged: 0, matched: 0, failed: 0 };
  const due = await db.recurringPayment.findMany({
    // Local "today" runs up to 14 hours ahead of UTC.
    where: { autoLog: true, nextDate: { lte: new Date(now.getTime() + 14 * 3600_000) }, ...(onlyUserId ? { userId: onlyUserId } : {}) },
    include: { user: { select: { timezone: true } } },
    take: 500,
  });
  for (const rp of due) {
    try {
      const today = localToday(rp.user.timezone, now);
      const cadence = rp.cadence as Cadence;
      let date = iso(rp.nextDate);
      for (let n = 0; date <= today && n < MAX_CATCH_UP; n++) {
        const next = nextCharge(date, cadence, rp.anchorDay);
        const outcome = await asBaseWriter(rp.userId, () => logOne(rp, date, next));
        if (outcome === "gone") break;
        if (outcome === "logged") result.logged++;
        if (outcome === "matched") result.matched++;
        date = next;
      }
    } catch (e) {
      result.failed++;
      console.error("[recurring] auto-log failed:", e instanceof Error ? e.message : String(e));
    }
  }
  if (result.logged || result.failed) logEvent("recurring_run", undefined, result);
  return result;
}

type Saved = { id: string; userId: string; name: string; amount: unknown; currency: string; categoryKey: string; accountId: string | null; nextDate: Date };

async function logOne(rp: Saved, date: string, next: string): Promise<"logged" | "matched" | "gone"> {
  const user = await db.user.findUniqueOrThrow({ where: { id: rp.userId }, select: { baseCurrency: true } });
  const amount = Number(rp.amount);
  const at = day(date);
  const account = rp.accountId
    ? await db.account.findFirst({ where: { id: rp.accountId, userId: rp.userId } })
    : await resolveAccount(rp.userId);
  if (!account) return "gone";
  const key = merchantKey(rp.name);
  const near = await db.transaction.findMany({
    where: {
      userId: rp.userId,
      type: "expense",
      amount,
      currency: rp.currency,
      occurredAt: { gte: new Date(at.getTime() - 3 * DAY_MS), lte: new Date(at.getTime() + 3 * DAY_MS) },
    },
    select: { merchant: true },
  });
  const already = near.some((t) => {
    const k = merchantKey(t.merchant ?? "");
    return !!k && (k.includes(key) || key.includes(k));
  });
  // Priced before the transaction opens: an FX lookup must not hold it.
  const priced = already ? null : await convert(amount, rp.currency, user.baseCurrency, at);
  return db.$transaction(async (tx) => {
    const { count } = await tx.recurringPayment.updateMany({
      where: { id: rp.id, autoLog: true, nextDate: at },
      data: { nextDate: day(next) },
    });
    if (count !== 1) return "gone" as const; // another tick, or the user changed it
    if (already || !priced) return "matched" as const;
    // A hand-logged row in every way that matters (source manual, no
    // external id): a statement import merges it with the bank's row.
    await tx.transaction.create({
      data: {
        userId: rp.userId,
        accountId: account.id,
        type: "expense",
        amount,
        currency: rp.currency,
        amountBase: priced.converted,
        fxRate: priced.rate,
        categoryKey: rp.categoryKey,
        merchant: rp.name,
        note: AUTO_LOG_NOTE,
        occurredAt: at,
        source: "manual",
        entity: account.entity,
      },
    });
    logEvent("recurring_logged", rp.userId, {});
    return "logged" as const;
  });
}

/**
 * After an import: the active recurring payments found that are not saved
 * yet, for the response. A statement shows a subscription the user forgot;
 * that is the moment to name it.
 */
export async function foundAfterImport(user: { id: string; baseCurrency: string; timezone: string }) {
  const today = localToday(user.timezone);
  const [found, saved] = await Promise.all([
    findRecurring(user.id, today),
    db.recurringPayment.findMany({ where: { userId: user.id }, select: { name: true, currency: true } }),
  ]);
  const fresh = found.filter((f) => f.status === "active" && !saved.some((s) => sameAs(f, s)));
  if (!fresh.length) return null;
  return {
    count: fresh.length,
    monthly_total: round2(fresh.reduce((a, f) => a + f.monthly_base, 0)),
    base_currency: user.baseCurrency,
    biggest: fresh.slice(0, 5).map((f) => ({ name: f.name, amount: f.amount, currency: f.currency, cadence: f.cadence })),
  };
}
