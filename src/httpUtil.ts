import { createHash } from "node:crypto";
import type { Request } from "express";

/** Small helpers shared by the sign-in, bank-consent and admin routes. */

export function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Drops expired entries, then the oldest past the cap (Map order is insertion order). */
export function pruneMap<T extends { expiresAt: number }>(map: Map<string, T>, max: number): void {
  const now = Date.now();
  for (const [key, entry] of map) if (entry.expiresAt < now) map.delete(key);
  for (const key of map.keys()) {
    if (map.size < max) break;
    map.delete(key);
  }
}
