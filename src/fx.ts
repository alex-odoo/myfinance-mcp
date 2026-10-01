import { db } from "./db";

/**
 * FX layer. Rates stored EUR-base per calendar date: rate = quote units per 1 EUR.
 * Sources: frankfurter.dev (ECB reference, ~30 currencies) + NBU for UAH +
 * AED via USD peg (3.6725). Fetch-on-demand with DB cache; no cron needed.
 * A transaction freezes its rate at occurredAt date forever (spec section 6.4).
 */

const AED_PER_USD = 3.6725;
const MAX_FALLBACK_DAYS = 7;

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

async function ratesInDb(date: Date): Promise<Map<string, number>> {
  const rows = await db.fxRate.findMany({ where: { date } });
  return new Map(rows.map((r) => [r.quote, Number(r.rate)]));
}

const covers = (rates: Map<string, number>, currencies: string[]) =>
  currencies.every((c) => c === "EUR" || rates.has(c));

/**
 * Fetch + cache what a date is missing for `needed`. Each source fills its
 * own part of the day: a day where one source answered must not freeze
 * without the other's (2026-10-01: NBU answered, ECB did not, the day held
 * UAH only, and every USD/GBP/AED conversion that day failed as "Unknown
 * currency"). USD present = the ECB set was fetched, so a currency still
 * missing then is one ECB does not publish; no refetch for it.
 */
async function ensureRates(date: Date, needed: string[]): Promise<Map<string, number>> {
  const cached = await ratesInDb(date);
  const missing = needed.filter((c) => c !== "EUR" && !cached.has(c));
  if (missing.length === 0) return cached;

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

  const fresh = Object.entries(fetched).filter(([quote]) => !cached.has(quote));
  if (fresh.length > 0) {
    await db.fxRate.createMany({
      data: fresh.map(([quote, rate]) => ({ date, quote, rate })),
      skipDuplicates: true,
    });
  }
  return new Map([...cached, ...fresh]);
}

/** No FX source publishes this currency (as opposed to the sources being down). */
export class UnknownCurrencyError extends Error {
  constructor(readonly currency: string) {
    super(`Unknown currency "${currency}". Use a 3-letter ISO code covered by ECB/NBU (e.g. EUR, USD, UAH, AED, GBP).`);
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
 * source answered (USD present = the ECB set arrived; UAH comes from NBU) is
 * one nobody publishes: UnknownCurrencyError at once. Missing because a
 * source was down, the nearest earlier cached day stands in, else
 * FxUnavailableError. Callers branch on the type, never on message text.
 */
async function ratesWithFallback(date: Date, needed: string[]): Promise<Map<string, number>> {
  const direct = await ensureRates(date, needed);
  if (covers(direct, needed)) return direct;

  const missing = needed.filter((c) => c !== "EUR" && !direct.has(c));
  const sourceDown = missing.some((c) => (c === "UAH" ? true : !direct.has("USD")));
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
