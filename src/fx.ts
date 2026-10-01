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

/**
 * Fallback rates for `date` (ISO codes, upper case), or the nearest earlier
 * published day within FALLBACK_DAYS_BACK. {} = the source answered and has
 * nothing for that date (before its first day); null = it did not answer.
 */
async function fetchFallback(date: string): Promise<Record<string, number> | null> {
  if (date < FALLBACK_FIRST_DAY) return {};
  for (let back = 0; back <= FALLBACK_DAYS_BACK; back++) {
    const day = dateKey(new Date(Date.parse(`${date}T00:00:00Z`) - back * 86_400_000));
    if (day < FALLBACK_FIRST_DAY) return {};
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
        return rates;
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
