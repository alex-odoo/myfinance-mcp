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
 * a cadence (weekly, monthly, quarterly, yearly) at a steady amount. Two
 * charges are enough for what is a bill by its category (subscriptions,
 * housing, utilities, education), a known subscription service, or a steady
 * price a quarter or a year apart; anything else needs three, weekly always
 * three. Everyday spending (groceries, cafes,
 * fuel) never counts, whatever its rhythm. A single recent charge from a
 * known subscription service is listed as seen once: its cadence is unknown
 * (an annual plan looks the same), so it stays out of totals and dates until
 * the user saves it.
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
/** A single charge from a subscription service is listed if it is this recent. */
const SINGLE_CHARGE_DAYS = 45;
const MAX_FOUND = 50;
/** How far ahead get_recurring and the email look for what is coming up. */
export const UPCOMING_DAYS = 30;
/** Auto-logging catches up at most this many missed dates per payment and run. */
const MAX_CATCH_UP = 12;
/** Auto-logging looks at the most overdue payments first, this many per tick. */
const MAX_DUE_PER_TICK = 500;
export const AUTO_LOG_NOTE = "Logged automatically: recurring payment";

// Spending that repeats by habit, not by contract.
const EVERYDAY = new Set(["groceries", "restaurants", "fuel", "clothing", "personal_care", "pharmacy", "gifts", "travel", "electronics"]);
// What is a bill by its category: two charges are enough.
const BILL_CATEGORIES = new Set(["subscriptions", "housing", "utilities", "education"]);
// Bills whose amount moves with use: a wider tolerance.
const VARIABLE_BILLS = new Set(["housing", "utilities"]);

// Services sold almost only as subscriptions, matched as whole words of the
// merchant key. App stores and shops (Apple, Google Play, PlayStation) sell
// one-off purchases too and are left out.
// Short or common words (ivi is also a clinic chain, tidal a word) only in
// their domain form.
const SUBSCRIPTION_SERVICES = [
  "netflix", "spotify", "youtube premium", "youtubepremium", "icloud", "google one", "disney+", "disney plus", "disneyplus",
  "hbo max", "hbomax", "max.com", "amazon prime", "prime video", "audible", "kindle unlimited", "adobe", "canva", "figma",
  "github", "openai", "chatgpt", "anthropic", "claude.ai", "midjourney", "dropbox", "zoom.us", "linkedin premium",
  "duolingo", "patreon", "deezer", "tidal.com", "yandex plus", "яндекс плюс", "кинопоиск", "okko", "ivi.ru", "wink.ru",
  "megogo", "sweet.tv", "1password", "nordvpn", "expressvpn", "protonmail", "proton ag", "grammarly", "jetbrains",
  "mubi", "crunchyroll", "paramount+", "paramountplus", "hulu", "dazn", "headspace", "calm.com", "apple tv+",
];
// Merchants that bill several subscriptions under one name: each fixed price is its own series.
const MULTI_BILLERS = ["apple.com", "itunes", "google", "microsoft", "amazon"];

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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SERVICE_RE = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${SUBSCRIPTION_SERVICES.map(escapeRe).join("|")})(?:$|[^\\p{L}\\p{N}])`, "u");
const isSubscriptionService = (key: string) => SERVICE_RE.test(key);
const isMultiBiller = (key: string) => MULTI_BILLERS.some((m) => key.includes(m));

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
  /** The merchant as the records spell it: pass it as `merchant` when saving under another name. */
  name: string;
  amount: number;
  currency: string;
  amount_varies: boolean;
  last_date: string;
  occurrences: number;
  status: "active" | "stopped";
  /** repeats: a cadence seen in the rows. seen_once: one charge of a subscription service, cadence unknown. */
  evidence: "repeats" | "seen_once";
  category: string;
  /** Only for repeats. */
  cadence?: Cadence;
  next_date?: string;
  monthly_base?: number;
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
  // Several charges on one day at one price are one charge (a double entry).
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
  const service = isSubscriptionService(key);
  const base = {
    name: last.merchant.trim().slice(0, 60),
    amount: round2(typical),
    currency,
    amount_varies: spread > 0.02,
    last_date: last.date,
    occurrences: series.length,
    category,
    key,
  };

  if (series.length === 1) {
    if (!service || daysBetween(last.date, today) > SINGLE_CHARGE_DAYS) return undefined;
    return { ...base, status: "active", evidence: "seen_once" };
  }
  const cadence = cadenceOf(series.map((r) => r.date));
  if (!cadence) return undefined;
  // Two charges are a pattern for a bill, a subscription service, or a
  // steady price a quarter or a year apart (an annual fee rarely has three
  // years of history); two taxi rides a week apart, or two cinema tickets a
  // month apart, are not. Weekly always needs three.
  const needed =
    cadence === "weekly" ? 3 : BILL_CATEGORIES.has(category) || service || cadence === "quarterly" || cadence === "yearly" ? 2 : 3;
  if (series.length < needed) return undefined;
  if (spread > (VARIABLE_BILLS.has(category) ? 0.35 : 0.1)) return undefined;
  const anchor = Number(last.date.slice(8, 10));
  const next = nextCharge(last.date, cadence, anchor);
  const stopped = daysBetween(next, today) > RULES[cadence].grace;
  return {
    ...base,
    status: stopped ? "stopped" : "active",
    evidence: "repeats",
    cadence,
    next_date: stopped ? next : rollForward(next, cadence, anchor, today),
    monthly_base: round2(median(series.map((r) => r.amountBase)) * RULES[cadence].perMonth),
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
      // A row the scheduler logged is the saved payment itself, not evidence.
      recurringId: null,
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
    // A price change splits one subscription in two plateaus: the latest
    // price on its own is the subscription now.
    if (!mixedDays && !isMultiBiller(g.key)) {
      const latest = g.rows.reduce((a, b) => (b.date > a.date ? b : a));
      const current = g.rows.filter((r) => r.amount === latest.amount);
      const p = current.length >= 2 && current.length < g.rows.length ? asPayment(g.key, g.currency, current, today) : undefined;
      if (p?.evidence === "repeats") found.push(p);
      continue;
    }
    // Each fixed price apart where one merchant bills several subscriptions.
    const byAmount = new Map<number, Row[]>();
    for (const r of g.rows) byAmount.set(r.amount, [...(byAmount.get(r.amount) ?? []), r]);
    for (const [amount, rs] of byAmount) {
      if (rs.length < 2) continue;
      const p = asPayment(g.key, g.currency, rs, today);
      if (p?.evidence === "repeats") found.push({ ...p, key: `${g.key} ${amount}` });
    }
  }
  return found.sort((a, b) => (b.monthly_base ?? -1) - (a.monthly_base ?? -1)).slice(0, MAX_FOUND);
}

// ---- saved ones, and both together

export interface SavedView {
  name: string;
  merchant?: string;
  amount: number;
  currency: string;
  cadence: Cadence;
  next_date: string;
  category: string;
  account?: string;
  auto_log: boolean;
  monthly_base: number | null;
}

type SavedLike = { name: string; merchant: string | null; currency: string; amount: unknown; cadence: string };

const labelMatches = (label: string | null, key: string) => {
  const a = label ? merchantKey(label) : "";
  return !!a && (a === key || (a.length >= 4 && key.includes(a)) || (key.length >= 4 && a.includes(key)));
};

/**
 * The found series that are not a saved payment. Each saved payment claims
 * at most one series: the one its merchant link or name points at (closest
 * price, when a multi-subscription merchant has several), or else, for one
 * saved under the user's own name ("Rent" for "LANDLORD SL"), the series of
 * the same currency and cadence with the closest amount: within 2%, or 35%
 * for a bill whose amount moves.
 */
function unsaved(found: FoundPayment[], saved: SavedLike[]): FoundPayment[] {
  const claimed = new Set<FoundPayment>();
  const closest = (amount: number, pool: FoundPayment[]) =>
    [...pool].sort((x, y) => Math.abs(x.amount - amount) - Math.abs(y.amount - amount))[0];
  const fallback: SavedLike[] = [];
  for (const s of saved) {
    const amount = Number(s.amount);
    const direct = found.filter((f) => !claimed.has(f) && f.currency === s.currency && (labelMatches(s.merchant, f.key) || labelMatches(s.name, f.key)));
    const pick = direct.length ? closest(amount, direct) : undefined;
    if (pick) claimed.add(pick);
    else fallback.push(s);
  }
  for (const s of fallback) {
    const amount = Number(s.amount);
    const pool = found.filter((f) => {
      if (claimed.has(f) || f.currency !== s.currency || f.cadence !== s.cadence || amount <= 0) return false;
      const tolerance = VARIABLE_BILLS.has(f.category) || f.amount_varies ? 0.35 : 0.02;
      return Math.abs(f.amount - amount) / amount <= tolerance;
    });
    const pick = closest(amount, pool);
    if (pick) claimed.add(pick);
  }
  return found.filter((f) => !claimed.has(f));
}

/** Everything get_recurring and the email show: saved, found (not saved), totals, coming up. */
export async function recurringOverview(
  user: { id: string; baseCurrency: string; timezone: string },
  now = new Date(),
  includeStopped = false
) {
  const today = localToday(user.timezone, now);
  const [savedRows, found, links] = await Promise.all([
    db.recurringPayment.findMany({ where: { userId: user.id }, include: { account: { select: { name: true } } }, orderBy: { name: "asc" } }),
    findRecurring(user.id, today),
    db.bankConnection.count({ where: { userId: user.id } }),
  ]);
  const saved: SavedView[] = [];
  for (const r of savedRows) {
    const cadence = r.cadence as Cadence;
    const amount = Number(r.amount);
    let monthly: number | null = null;
    try {
      monthly = round2((await convert(amount, r.currency, user.baseCurrency, day(today))).converted * RULES[cadence].perMonth);
    } catch {
      monthly = null; // no rate today: `unpriced` names it
    }
    saved.push({
      name: r.name,
      ...(r.merchant ? { merchant: r.merchant } : {}),
      amount,
      currency: r.currency,
      cadence,
      // Auto-logged ones are kept current by the scheduler; others roll here.
      next_date: rollForward(iso(r.nextDate), cadence, r.anchorDay, today),
      category: r.categoryKey,
      ...(r.account ? { account: r.account.name } : {}),
      // A bank or ZenMoney link stops the scheduler (the sync brings the charge).
      auto_log: r.autoLog && links === 0,
      monthly_base: monthly,
    });
  }
  const suggestions = unsaved(found, savedRows).filter((f) => includeStopped || f.status === "active");
  const counted = suggestions.filter((f) => f.status === "active" && f.evidence === "repeats");
  const monthly = round2(saved.reduce((a, s) => a + (s.monthly_base ?? 0), 0) + counted.reduce((a, f) => a + (f.monthly_base ?? 0), 0));
  const horizon = iso(new Date(day(today).getTime() + UPCOMING_DAYS * DAY_MS));
  const upcoming = [
    ...saved.map((s) => ({ name: s.name, date: s.next_date, amount: s.amount, currency: s.currency, saved: true })),
    ...counted.map((f) => ({ name: f.name, date: f.next_date!, amount: f.amount, currency: f.currency, saved: false })),
  ]
    .filter((u) => u.date >= today && u.date <= horizon)
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    today,
    base_currency: user.baseCurrency,
    // Saved payments plus found ones that repeat; seen-once charges have no
    // known cadence and are left out until saved.
    monthly_total: monthly,
    yearly_total: round2(monthly * 12),
    unpriced: saved.filter((s) => s.monthly_base === null).map((s) => s.name),
    saved,
    found: suggestions.map(({ key: _key, ...f }) => f),
    upcoming,
  };
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
    db.recurringPayment.findMany({ where: { userId: user.id }, select: { name: true, merchant: true, currency: true, amount: true, cadence: true } }),
  ]);
  const fresh = unsaved(found, saved).filter((f) => f.status === "active");
  const repeating = fresh.filter((f) => f.evidence === "repeats");
  const once = fresh.filter((f) => f.evidence === "seen_once");
  if (!fresh.length) return null;
  return {
    count: repeating.length,
    monthly_total: round2(repeating.reduce((a, f) => a + (f.monthly_base ?? 0), 0)),
    base_currency: user.baseCurrency,
    biggest: repeating.slice(0, 5).map((f) => ({ name: f.name, amount: f.amount, currency: f.currency, cadence: f.cadence })),
    // One charge of a subscription service each: how often is for the user to say.
    ...(once.length ? { seen_once: once.slice(0, 5).map((f) => ({ name: f.name, amount: f.amount, currency: f.currency })) } : {}),
  };
}

// ---- writing them on their date

/**
 * One scheduler tick: every saved payment with auto_log whose date has come
 * (in the user's timezone) is written as an expense, and its next date set,
 * in one transaction: a concurrent or later tick finds the date moved and
 * writes nothing. A charge already in the books (by hand or imported within
 * 3 days, same amount) only moves the date, and so does a user who has since
 * connected a bank or ZenMoney sync (the sync brings the charge). A date the
 * FX sources cannot price stays due and is retried. onlyUserId scopes a test.
 */
export async function runRecurring(now = new Date(), onlyUserId?: string) {
  const result = { logged: 0, matched: 0, synced: 0, skipped: 0, failed: 0 };
  const due = await db.recurringPayment.findMany({
    // Local "today" runs up to 14 hours ahead of UTC.
    where: { autoLog: true, nextDate: { lte: new Date(now.getTime() + 14 * 3600_000) }, ...(onlyUserId ? { userId: onlyUserId } : {}) },
    include: { user: { select: { timezone: true, baseCurrency: true, _count: { select: { bankConnections: true } } } } },
    orderBy: { nextDate: "asc" },
    take: MAX_DUE_PER_TICK,
  });
  for (const rp of due) {
    try {
      const today = localToday(rp.user.timezone, now);
      const cadence = rp.cadence as Cadence;
      const first = iso(rp.nextDate);
      if (first > today) continue;
      if (rp.user._count.bankConnections > 0) {
        // The sync brings these charges: only the date moves, past today.
        let next = first;
        while (next <= today) next = nextCharge(next, cadence, rp.anchorDay);
        const { count } = await db.recurringPayment.updateMany({ where: { id: rp.id, autoLog: true, nextDate: rp.nextDate }, data: { nextDate: day(next) } });
        result[count === 1 ? "synced" : "skipped"]++;
        continue;
      }
      let date = first;
      for (let n = 0; date <= today && n < MAX_CATCH_UP; n++) {
        const next = nextCharge(date, cadence, rp.anchorDay);
        const outcome = await asBaseWriter(rp.userId, () => logOne(rp, date, next));
        result[outcome]++;
        if (outcome === "skipped") break;
        date = next;
      }
    } catch (e) {
      result.failed++;
      console.error("[recurring] auto-log failed:", e instanceof Error ? e.message : String(e));
    }
  }
  if (result.logged || result.failed || result.skipped) logEvent("recurring_run", undefined, result);
  return result;
}

type Saved = { id: string; userId: string; name: string; amount: unknown; currency: string; categoryKey: string; accountId: string | null };

async function logOne(rp: Saved, date: string, next: string): Promise<"logged" | "matched" | "skipped"> {
  const amount = Number(rp.amount);
  const at = day(date);
  // The same amount near the date is this charge (logged by hand, imported,
  // or this payment's own row), unless it is another saved payment's
  // auto-logged row (two 9.99 subscriptions on one day).
  const near = await db.transaction.findMany({
    where: {
      userId: rp.userId,
      type: "expense",
      amount,
      currency: rp.currency,
      occurredAt: { gte: new Date(at.getTime() - 3 * DAY_MS), lte: new Date(at.getTime() + 3 * DAY_MS) },
    },
    select: { recurringId: true },
  });
  const already = near.some((t) => t.recurringId === null || t.recurringId === rp.id);
  const account = already
    ? null
    : rp.accountId
      ? await db.account.findFirst({ where: { id: rp.accountId, userId: rp.userId } })
      : await resolveAccount(rp.userId);
  if (!already && !account) return "skipped";
  // The base is read inside the base-switch gate (runRecurring holds it), and
  // priced before the transaction opens: an FX lookup must not hold it.
  const { baseCurrency } = await db.user.findUniqueOrThrow({ where: { id: rp.userId }, select: { baseCurrency: true } });
  const priced = already ? null : await convert(amount, rp.currency, baseCurrency, at);
  return db.$transaction(async (tx) => {
    const { count } = await tx.recurringPayment.updateMany({
      where: { id: rp.id, autoLog: true, nextDate: at },
      data: { nextDate: day(next) },
    });
    if (count !== 1) return "skipped" as const; // another tick, or the user changed it
    if (already || !account || !priced) return "matched" as const;
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
        // A hand-logged row in every way an import looks at (source manual,
        // no external id), linked to its payment: the import merges it with
        // the bank's row by amount and date.
        source: "manual",
        recurringId: rp.id,
        entity: account.entity,
      },
    });
    logEvent("recurring_logged", rp.userId, {});
    return "logged" as const;
  });
}
