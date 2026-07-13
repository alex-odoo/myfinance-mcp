import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import { config } from "./config";

export const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.databaseUrl }),
});

/** Fire-and-forget analytics event (spec: retention truth source). */
export function logEvent(type: string, userId?: string, meta?: Record<string, string | number | boolean | null>): void {
  db.event
    .create({ data: { type, userId, meta: meta ?? undefined } })
    .catch(() => {});
}
