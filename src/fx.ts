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

/** Rates covering `needed` for date, else the nearest earlier cached day that covers them. */
async function ratesWithFallback(date: Date, needed: string[]): Promise<Map<string, number>> {
  const direct = await ensureRates(date, needed);
  if (covers(direct, needed)) return direct;

  for (let i = 1; i <= MAX_FALLBACK_DAYS; i++) {
    const cached = await ratesInDb(new Date(date.getTime() - i * 86_400_000));
    if (covers(cached, needed)) return cached;
  }
  if (direct.size === 0) throw new Error("FX rates unavailable: all sources down and no cached rates within 7 days");
  return direct; // the day is fetched but no source publishes the currency: eurPer names it
}

function eurPer(rates: Map<string, number>, currency: string): number {
  if (currency === "EUR") return 1;
  const perEur = rates.get(currency);
  if (!perEur) {
    throw new Error(
      `Unknown currency "${currency}". Use a 3-letter ISO code covered by ECB/NBU (e.g. EUR, USD, UAH, AED, GBP).`
    );
  }
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

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
