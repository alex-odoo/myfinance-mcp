import { db } from "./db";
import { config } from "./config";

export interface SessionUser {
  id: string;
  email: string;
}

/**
 * M1 is single-user: the env-configured account is upserted at boot.
 * Real signup (Google + email/password) replaces this in a later milestone;
 * everything downstream already keys on users.id.
 */
export async function bootstrapUser(): Promise<void> {
  await db.user.upsert({
    where: { email: config.userEmail },
    update: { passwordHash: config.passwordHash },
    create: {
      email: config.userEmail,
      passwordHash: config.passwordHash,
      baseCurrency: "EUR",
      timezone: "Europe/Kyiv",
    },
  });
}

export async function verifyLogin(email: string, password: string): Promise<SessionUser | null> {
  const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user?.passwordHash) return null;
  const ok = await Bun.password.verify(password, user.passwordHash).catch(() => false);
  return ok ? { id: user.id, email: user.email } : null;
}
