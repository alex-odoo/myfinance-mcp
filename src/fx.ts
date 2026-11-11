import { db } from "./db";

/**
 * FX layer. Rates stored EUR-base per calendar date: rate = quote units per 1 EUR.
 * Sources: frankfurter.dev (ECB reference, ~30 currencies) + NBU for UAH +
 * AED via USD peg (3.6725), then a fallback for every other ISO currency
 * (RUB, KZT, GEL, ...). Fetch-on-demand with DB cache; no cron needed.
 * A transaction freezes its rate at occurredAt date forever (spec section 6.4).
 */

const AED_PER_USD = 3.6725;
const MAX_FALLBACK_DAYS = 7;

// The fallback: fawazahmed0/currency-api, a free daily EUR snapshot of ~340
// codes, published on jsDelivr and mirrored on Cloudflare Pages, from
// 2024-03-02 on. Asked only for what ECB and NBU do not publish, so an ECB
// day keeps ECB's numbers. Only ISO 4217 codes are taken (it lists crypto too).
const FALLBACK_FIRST_DAY = "2024-03-02";
const FALLBACK_DAYS_BACK = 3; // a day's file appears after midnight UTC
const ISO_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

/** An ISO 4217 code: the only kind any rate source here prices (crypto never is). */
export function isIsoCurrency(code: string): boolean {
  return ISO_CURRENCIES.has(code);
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function fetchFrankfurter(date: string): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(`https://api.frankfurter.dev/v1/${date}?base=EUR`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { rates?: Record<string, number> };
    return data.rates ?? null;
  } catch {
    return null;
  }
}

async function fetchNbuUahPerEur(date: string): Promise<number | null> {
  try {
    const compact = date.replaceAll("-", "");
    const res = await fetch(
      `https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=EUR&date=${compact}&json`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ rate?: number }>;
    return data[0]?.rate ?? null;
  } catch {
    return null;
  }
}

const fallbackUrls = (day: string) => [
  `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${day}/v1/currencies/eur.min.json`,
  `https://${day}.currency-api.pages.dev/v1/currencies/eur.min.json`,
];

// Answered days, so a second currency or a code the snapshot lacks on the
// same date costs no download. Map order = insertion: the oldest goes first.
const fallbackDays = new Map<string, Record<string, number>>();
const FALLBACK_CACHE_DAYS = 400;

/**
 * Fallback rates for `date` (ISO codes, upper case), or the nearest earlier
 * published day within FALLBACK_DAYS_BACK. {} = the source answered and has
 * nothing for that date (before its first day); null = it did not answer.
 */
async function fetchFallback(date: string): Promise<Record<string, number> | null> {
  if (date < FALLBACK_FIRST_DAY) return {};
  const known = fallbackDays.get(date);
  if (known) return known;
  const got = await downloadFallback(date);
  // An earlier day standing in for one not published yet is not cached:
  // the day's own file replaces it once it appears.
  if (got?.day === date) {
    if (fallbackDays.size >= FALLBACK_CACHE_DAYS) fallbackDays.delete(fallbackDays.keys().next().value!);
    fallbackDays.set(date, got.rates);
  }
  return got?.rates ?? null;
}

async function downloadFallback(date: string): Promise<{ rates: Record<string, number>; day: string } | null> {
  for (let back = 0; back <= FALLBACK_DAYS_BACK; back++) {
    const day = dateKey(new Date(Date.parse(`${date}T00:00:00Z`) - back * 86_400_000));
    if (day < FALLBACK_FIRST_DAY) return { rates: {}, day: date };
    let missingDay = false;
    for (const url of fallbackUrls(day)) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (res.status === 404) {
          missingDay = true;
          break; // both mirrors carry the same days
        }
        if (!res.ok) continue;
        const data = (await res.json()) as { eur?: Record<string, number> };
        if (!data.eur) continue;
        const rates: Record<string, number> = {};
        for (const [code, rate] of Object.entries(data.eur)) {
          const quote = code.toUpperCase();
          if (ISO_CURRENCIES.has(quote) && quote !== "EUR" && typeof rate === "number" && rate > 0) rates[quote] = rate;
        }
        return { rates, day };
      } catch {
        /* try the mirror */
      }
    }
    if (!missingDay) return null; // both mirrors down
  }
  return null; // nothing published for days: treat as an outage
}

async function ratesInDb(date: Date): Promise<Map<string, number>> {
  const rows = await db.fxRate.findMany({ where: { date } });
  return new Map(rows.map((r) => [r.quote, Number(r.rate)]));
}

const covers = (rates: Map<string, number>, currencies: string[]) =>
  currencies.every((c) => c === "EUR" || rates.has(c));

/** A day's rates, and whether the fallback answered while filling them. */
interface DayRates {
  rates: Map<string, number>;
  fallbackAnswered: boolean;
}

/**
 * Fetch + cache what a date is missing for `needed`. Each source fills its
 * own part of the day: a day where one source answered must not freeze
 * without the other's (2026-10-01: NBU answered, ECB did not, the day held
 * UAH only, and every USD/GBP/AED conversion that day failed as "Unknown
 * currency"). USD present = the ECB set was fetched, so a currency still
 * missing then is one ECB does not publish: the fallback is asked for it,
 * and only what was asked for is stored (the day stays ECB's otherwise).
 */
async function ensureRates(date: Date, needed: string[]): Promise<DayRates> {
  const cached = await ratesInDb(date);
  const missing = needed.filter((c) => c !== "EUR" && !cached.has(c));
  if (missing.length === 0) return { rates: cached, fallbackAnswered: false };

  const key = dateKey(date);
  const fetched: Record<string, number> = {};
  if (missing.some((c) => c !== "UAH") && !cached.has("USD")) {
    const ecb = await fetchFrankfurter(key);
    if (ecb) Object.assign(fetched, ecb);
  }
  if (missing.includes("UAH")) {
    const uahPerEur = await fetchNbuUahPerEur(key);
    if (uahPerEur) fetched.UAH = uahPerEur;
  }
  const usd = fetched.USD ?? cached.get("USD");
  if (usd && !cached.has("AED")) fetched.AED ??= usd * AED_PER_USD;

  let fallbackAnswered = false;
  const beyondEcb = usd ? missing.filter((c) => c !== "UAH" && !(c in fetched) && ISO_CURRENCIES.has(c)) : [];
  if (beyondEcb.length > 0) {
    const fallback = await fetchFallback(key);
    if (fallback) {
      fallbackAnswered = true;
      for (const c of beyondEcb) if (fallback[c]) fetched[c] = fallback[c];
    }
  }

  const fresh = Object.entries(fetched).filter(([quote]) => !cached.has(quote));
  if (fresh.length > 0) {
    await db.fxRate.createMany({
      data: fresh.map(([quote, rate]) => ({ date, quote, rate })),
      skipDuplicates: true,
    });
  }
  return { rates: new Map([...cached, ...fresh]), fallbackAnswered };
}

/** Fewer days than this are cheaper one request each (the per-day path). */
const PREFETCH_MIN_DAYS = 5;
/**
 * A series is worth one download only when the days it serves are dense
 * enough: at least one needed day per this many days of span (16 years of
 * series is ~2 MB; five days scattered over them are cheaper one by one).
 */
const PREFETCH_SPAN_PER_DAY = 60;
const PREFETCH_ROWS_PER_INSERT = 5_000;
/** Fallback day files downloaded at once (one file per day: the source has no ranges). */
const PREFETCH_FALLBACK_PARALLEL = 6;
const DAY_MS = 86_400_000;
const ECB_MARKER = "USD"; // USD present = the day's ECB set is stored (ensureRates reads it so)

const atMidnight = (day: string) => new Date(`${day}T00:00:00.000Z`);
type RateRow = { date: Date; quote: string; rate: number };

/** The days of `days` (sorted, distinct) without `quote` cached, or [] when too few or too sparse for a series. */
async function daysWorthASeries(days: string[], quote: string): Promise<string[]> {
  if (days.length < PREFETCH_MIN_DAYS) return [];
  const cached = await db.fxRate.findMany({ where: { quote, date: { in: days.map(atMidnight) } }, select: { date: true } });
  const have = new Set(cached.map((r) => dateKey(r.date)));
  const missing = days.filter((d) => !have.has(d));
  if (missing.length < PREFETCH_MIN_DAYS) return [];
  const spanDays = (Date.parse(missing.at(-1)!) - Date.parse(missing[0]!)) / DAY_MS + 1;
  return missing.length * PREFETCH_SPAN_PER_DAY >= spanDays ? missing : [];
}

async function storeRates(rows: RateRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += PREFETCH_ROWS_PER_INSERT) {
    await db.fxRate.createMany({ data: rows.slice(i, i + PREFETCH_ROWS_PER_INSERT), skipDuplicates: true });
  }
}

/**
 * The ECB set for `days`, from one frankfurter time-series request. A day ECB
 * did not publish (weekend, holiday) takes the last published day before it,
 * as the single-day endpoint answers (2019-01-05 -> 2019-01-04); the series
 * opens with the business day before the range, so a range that starts on a
 * weekend is covered too. The marker (USD) of every day goes in last: a day
 * shows its marker only once its whole set is stored, so a failed or
 * concurrent insert never leaves a day that looks complete with part missing.
 */
async function prefetchEcb(days: string[]): Promise<void> {
  const missing = await daysWorthASeries(days, ECB_MARKER);
  if (!missing.length) return;
  const res = await fetch(`https://api.frankfurter.dev/v1/${missing[0]}..${missing.at(-1)}?base=EUR`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return;
  const series = ((await res.json()) as { rates?: Record<string, Record<string, number>> }).rates ?? {};
  const published = Object.keys(series).sort();
  const rest: RateRow[] = [];
  const markers: RateRow[] = [];
  let at = -1; // the last published day on or before `day`
  for (const day of missing) {
    while (at + 1 < published.length && published[at + 1]! <= day) at++;
    if (at < 0) continue; // before the series: the per-day path asks
    for (const [quote, rate] of Object.entries(series[published[at]!]!)) {
      if (typeof rate === "number" && rate > 0) (quote === ECB_MARKER ? markers : rest).push({ date: atMidnight(day), quote, rate });
    }
  }
  await storeRates(rest);
  await storeRates(markers);
}

/** UAH per EUR for `days`, from one NBU range request (NBU publishes every calendar day). */
async function prefetchUah(days: string[]): Promise<void> {
  const missing = await daysWorthASeries(days, "UAH");
  if (!missing.length) return;
  const compact = (d: string) => d.replaceAll("-", "");
  const res = await fetch(
    `https://bank.gov.ua/NBU_Exchange/exchange_site?start=${compact(missing[0]!)}&end=${compact(missing.at(-1)!)}&valcode=eur&sort=exchangedate&order=asc&json`,
    { signal: AbortSignal.timeout(30_000) }
  );
  if (!res.ok) return;
  const byDay = new Map<string, number>();
  for (const r of (await res.json()) as Array<{ exchangedate?: string; rate_per_unit?: number }>) {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(r.exchangedate ?? "");
    if (m && typeof r.rate_per_unit === "number" && r.rate_per_unit > 0) byDay.set(`${m[3]}-${m[2]}-${m[1]}`, r.rate_per_unit);
  }
  await storeRates(missing.filter((d) => byDay.has(d)).map((d) => ({ date: atMidnight(d), quote: "UAH", rate: byDay.get(d)! })));
}

/**
 * Currencies ECB does not publish on a day (RUB since 2022-03, KZT, GEL, ...)
 * come from the fallback's one file per day: no range exists, so after the
 * ECB set is stored the days still missing one of `currencies` are fetched a
 * few at a time instead of one by one in the pricing loop, and only the
 * currencies asked for are stored (as ensureRates does).
 */
async function prefetchFallback(days: string[], currencies: string[]): Promise<void> {
  const fbDays = days.filter((d) => d >= FALLBACK_FIRST_DAY);
  if (fbDays.length < PREFETCH_MIN_DAYS || !currencies.length) return;
  const stored = await db.fxRate.findMany({
    where: { date: { in: fbDays.map(atMidnight) }, quote: { in: [ECB_MARKER, ...currencies] } },
    select: { date: true, quote: true },
  });
  const byDay = new Map<string, Set<string>>();
  for (const r of stored) {
    const key = dateKey(r.date);
    byDay.set(key, (byDay.get(key) ?? new Set()).add(r.quote));
  }
  // Only days whose ECB set is stored: on those a currency still missing is one ECB did not publish.
  const todo = fbDays.filter((d) => byDay.get(d)?.has(ECB_MARKER) && currencies.some((c) => !byDay.get(d)!.has(c)));
  for (let i = 0; i < todo.length; i += PREFETCH_FALLBACK_PARALLEL) {
    const batch = todo.slice(i, i + PREFETCH_FALLBACK_PARALLEL);
    const files = await Promise.all(batch.map((d) => fetchFallback(d)));
    const rows: RateRow[] = [];
    batch.forEach((day, k) => {
      for (const c of currencies) {
        const rate = files[k]?.[c];
        if (rate && !byDay.get(day)!.has(c)) rows.push({ date: atMidnight(day), quote: c, rate });
      }
    });
    await storeRates(rows);
  }
}

/**
 * Caches, before a batch of rows is priced, the rates of their days with ONE
 * request per source instead of one per day: a first ZenMoney sync of
 * 2010-2020 history asked for 1,260 days one by one, and one failed request
 * stopped it (2026-11-11). ECB (frankfurter) and NBU (UAH) publish ranges;
 * other currencies come from the fallback's day files, a few at a time. Each
 * source gets only the days of rows that need it; rows already in `base` need
 * no rate. Best effort: whatever is still missing goes the per-day way, so
 * this never makes a conversion fail.
 */
export async function prefetchRates(rows: Array<{ currency: string; date: Date }>, base: string): Promise<void> {
  const ecbDays = new Set<string>();
  const uahDays = new Set<string>();
  const others = new Set<string>();
  for (const r of rows) {
    if (r.currency === base || Number.isNaN(r.date.getTime())) continue;
    const day = dateKey(r.date);
    for (const c of [r.currency, base]) {
      if (c === "EUR") continue;
      if (c === "UAH") uahDays.add(day);
      else {
        ecbDays.add(day); // the ECB set first, also to learn which codes it lacks that day
        if (ISO_CURRENCIES.has(c)) others.add(c);
      }
    }
  }
  const sorted = (days: Set<string>) => [...days].sort();
  try {
    await Promise.all([prefetchEcb(sorted(ecbDays)), prefetchUah(sorted(uahDays))]);
    await prefetchFallback(sorted(ecbDays), [...others]);
  } catch {
    /* the per-day path fetches what is still missing */
  }
}

/** No FX source publishes this currency (as opposed to the sources being down). */
export class UnknownCurrencyError extends Error {
  constructor(readonly currency: string) {
    super(
      `No exchange rate for "${currency}" on that date. Use a 3-letter ISO 4217 code (EUR, USD, GBP, UAH, RUB, ...); ` +
        `currencies outside the ECB set are priced from ${FALLBACK_FIRST_DAY} on.`
    );
  }
}

/** The day's sources did not answer and no earlier cached day (7) covers the currency. */
export class FxUnavailableError extends Error {
  constructor() {
    super("FX rates unavailable: all sources down and no cached rates within 7 days");
  }
}

/**
 * Rates covering `needed` for date. A currency missing from a day whose
 * sources answered (USD present = the ECB set arrived, then the fallback
 * answered or the code is not ISO at all) is one nobody publishes:
 * UnknownCurrencyError at once. Missing because a source was down, the
 * nearest earlier cached day stands in, else FxUnavailableError. Callers
 * branch on the type, never on message text.
 */
async function ratesWithFallback(date: Date, needed: string[]): Promise<Map<string, number>> {
  const { rates: direct, fallbackAnswered } = await ensureRates(date, needed);
  if (covers(direct, needed)) return direct;

  const missing = needed.filter((c) => c !== "EUR" && !direct.has(c));
  const sourceDown = missing.some((c) => {
    if (c === "UAH") return true; // NBU publishes UAH every day
    if (!direct.has("USD")) return true; // ECB did not answer
    return ISO_CURRENCIES.has(c) && !fallbackAnswered;
  });
  if (!sourceDown) throw new UnknownCurrencyError(missing[0]!);

  for (let i = 1; i <= MAX_FALLBACK_DAYS; i++) {
    const cached = await ratesInDb(new Date(date.getTime() - i * 86_400_000));
    if (covers(cached, needed)) return cached;
  }
  throw new FxUnavailableError();
}

function eurPer(rates: Map<string, number>, currency: string): number {
  if (currency === "EUR") return 1;
  const perEur = rates.get(currency);
  if (!perEur) throw new UnknownCurrencyError(currency);
  return 1 / perEur;
}

/** Convert amount between currencies at the given date's frozen rate. */
export async function convert(
  amount: number,
  from: string,
  to: string,
  date: Date
): Promise<{ converted: number; rate: number }> {
  if (from === to) return { converted: round2(amount), rate: 1 };
  const rates = await ratesWithFallback(date, [from, to]);
  const rate = eurPer(rates, from) / eurPer(rates, to);
  return { converted: round2(amount * rate), rate };
}

/**
 * Refuse a currency no FX source covers BEFORE it is stored on an account or
 * as the base: every later balance, summary and net worth would fail on it.
 * During an outage the currency cannot be checked and is let through.
 */
export async function assertConvertible(currency: string): Promise<void> {
  if (currency === "EUR") return;
  try {
    await convert(1, currency, "EUR", new Date(`${dateKey(new Date())}T00:00:00.000Z`));
  } catch (e) {
    if (e instanceof UnknownCurrencyError) throw e;
  }
}

/**
 * Prices synced rows. A currency no source publishes is skipped and counted
 * (the sync goes on and its cursor advances; a full re-sync picks the rows up
 * once a source covers the currency); an outage throws, so the sync stops
 * with its cursor where it was and the next run retries.
 */
export class RowPricer {
  readonly unpriced = new Map<string, number>(); // currency -> rows skipped
  private readonly unknown = new Set<string>(); // "CUR|day" known unpublished

  constructor(private readonly base: string) {}

  async price(amount: number, currency: string, date: Date): Promise<{ converted: number; rate: number } | null> {
    const key = `${currency}|${date.toISOString().slice(0, 10)}`;
    if (!this.unknown.has(key)) {
      try {
        return await convert(amount, currency, this.base, date);
      } catch (e) {
        if (!(e instanceof UnknownCurrencyError)) throw e;
        this.unknown.add(key);
      }
    }
    this.unpriced.set(currency, (this.unpriced.get(currency) ?? 0) + 1);
    return null;
  }

  /** Short lastError for a sync that skipped rows: currency codes only. */
  lastError(): string | null {
    if (this.unpriced.size === 0) return null;
    const rows = [...this.unpriced.values()].reduce((s, n) => s + n, 0);
    return `Skipped ${rows} row(s) with no exchange rate: ${[...this.unpriced.keys()].join(", ")}.`;
  }
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
