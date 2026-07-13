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

/** Fetch + cache rates for a date. Returns the map (may be empty if all sources down). */
async function ensureRates(date: Date): Promise<Map<string, number>> {
  const existing = await ratesInDb(date);
  if (existing.size > 0) return existing;

  const key = dateKey(date);
  const rates: Record<string, number> = {};

  const ecb = await fetchFrankfurter(key);
  if (ecb) Object.assign(rates, ecb);

  const uahPerEur = await fetchNbuUahPerEur(key);
  if (uahPerEur) rates.UAH = uahPerEur;

  if (rates.USD && !rates.AED) rates.AED = rates.USD * AED_PER_USD;

  if (Object.keys(rates).length === 0) return existing; // all sources down

  await db.fxRate.createMany({
    data: Object.entries(rates).map(([quote, rate]) => ({ date, quote, rate })),
    skipDuplicates: true,
  });
  return new Map(Object.entries(rates));
}

/** Rates for date with fallback to the nearest earlier cached/fetchable day. */
async function ratesWithFallback(date: Date): Promise<{ rates: Map<string, number>; usedDate: Date }> {
  const direct = await ensureRates(date);
  if (direct.size > 0) return { rates: direct, usedDate: date };

  for (let i = 1; i <= MAX_FALLBACK_DAYS; i++) {
    const earlier = new Date(date.getTime() - i * 86_400_000);
    const cached = await ratesInDb(earlier);
    if (cached.size > 0) return { rates: cached, usedDate: earlier };
  }
  throw new Error("FX rates unavailable: all sources down and no cached rates within 7 days");
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
  const { rates } = await ratesWithFallback(date);
  const rate = eurPer(rates, from) / eurPer(rates, to);
  return { converted: round2(amount * rate), rate };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
