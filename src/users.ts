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

/**
 * Google sign-in provisioning. Identity anchor is Google's stable `sub`;
 * a user who signed up by email first gets the sub linked on first Google
 * login (same verified email = same person, Google enforces verification).
 */
export async function findOrCreateGoogleUser(email: string, sub: string): Promise<SessionUser> {
  const bySub = await db.user.findUnique({ where: { googleSub: sub } });
  if (bySub) return { id: bySub.id, email: bySub.email };

  const normalized = email.trim().toLowerCase();
  const byEmail = await db.user.findUnique({ where: { email: normalized } });
  if (byEmail) {
    await db.user.update({ where: { id: byEmail.id }, data: { googleSub: sub } });
    return { id: byEmail.id, email: byEmail.email };
  }

  const created = await db.user.create({
    data: { email: normalized, googleSub: sub, baseCurrency: "EUR", timezone: "UTC" },
  });
  return { id: created.id, email: created.email };
}

export async function verifyLogin(email: string, password: string): Promise<SessionUser | null> {
  const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user?.passwordHash) return null;
  const ok = await Bun.password.verify(password, user.passwordHash).catch(() => false);
  return ok ? { id: user.id, email: user.email } : null;
}
