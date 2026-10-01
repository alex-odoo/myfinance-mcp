import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import { config } from "./config";
import { SUPABASE_ROOT_CA_2021 } from "./supabaseCa";

/**
 * TLS for the database link. node-postgres defaults to plaintext and the
 * Supabase pooler accepts it, so every row, password hash and OAuth token
 * crossed the internet unencrypted until 2026-10-01. Supabase hosts are now
 * verified against Supabase's own root CA. An explicit sslmode in
 * DATABASE_URL wins (e.g. sslmode=no-verify as an escape hatch if Supabase
 * ever rotates its root before the pinned one expires); other hosts follow
 * the URL as before.
 */
function sslFor(url: string): { ca: string; rejectUnauthorized: true } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.searchParams.has("sslmode")) return undefined;
  return /\.supabase\.(com|co)$/i.test(parsed.hostname)
    ? { ca: SUPABASE_ROOT_CA_2021, rejectUnauthorized: true }
    : undefined;
}

export const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.databaseUrl, ssl: sslFor(config.databaseUrl) }),
});

/** Fire-and-forget analytics event (spec: retention truth source). */
export function logEvent(type: string, userId?: string, meta?: Record<string, string | number | boolean | null>): void {
  db.event
    .create({ data: { type, userId, meta: meta ?? undefined } })
    .catch(() => {});
}
