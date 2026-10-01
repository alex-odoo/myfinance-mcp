import { db } from "./db";
import { config } from "./config";
import { notifySignup } from "./notify";

export interface SessionUser {
  id: string;
  email: string;
}

/**
 * The env-configured operator account (email + password), upserted at boot.
 * Everyone else signs up with Google or a one-time code sent by email.
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

/** The verified email belongs to an account already linked to another Google identity. */
export class GoogleAccountConflictError extends Error {
  constructor() {
    super("email is linked to a different Google account");
  }
}

/**
 * Google sign-in provisioning. Identity anchor is Google's stable `sub`. An
 * account without a Google identity yet (created with a password, like the
 * bootstrapped operator) is linked on its first Google sign-in with the same
 * verified email. An account linked to a different sub is refused, never
 * re-linked: a reassigned Workspace mailbox or a re-registered domain hands
 * the same address to another person.
 */
export async function findOrCreateGoogleUser(email: string, sub: string): Promise<SessionUser> {
  const bySub = await db.user.findUnique({ where: { googleSub: sub } });
  if (bySub) return { id: bySub.id, email: bySub.email };

  const normalized = email.trim().toLowerCase();
  const byEmail = await db.user.findUnique({ where: { email: normalized } });
  if (byEmail) {
    // Conditional write: links only while no Google identity is set, so two
    // first sign-ins racing cannot both claim the account.
    const { count } = await db.user.updateMany({
      where: { id: byEmail.id, googleSub: null },
      data: { googleSub: sub },
    });
    if (count !== 1) {
      // A concurrent first sign-in by the same Google identity (double submit,
      // two tabs) may have linked it a moment ago: same person, no conflict.
      const linked = await db.user.findUnique({ where: { id: byEmail.id }, select: { googleSub: true } });
      if (linked?.googleSub !== sub) throw new GoogleAccountConflictError();
    }
    return { id: byEmail.id, email: byEmail.email };
  }

  const created = await db.user.create({
    data: { email: normalized, googleSub: sub, baseCurrency: "EUR", timezone: "UTC" },
  });
  notifySignup(created.email, "google");
  return { id: created.id, email: created.email };
}

/** How an account that may not use email codes signs in instead. */
export type OtherSignIn = "google" | "password";

/** The account signs in another way; an emailed code would bypass what guards it. */
export class NoEmailSignInError extends Error {
  constructor(readonly method: OtherSignIn) {
    super(`account signs in with ${method}`);
  }
}

const otherSignIn = (u: { googleSub: string | null; passwordHash: string | null }): OtherSignIn | null =>
  u.googleSub ? "google" : u.passwordHash ? "password" : null;

/**
 * Email-code sign-in: the code proved control of the mailbox, which is the
 * whole identity of an email account (created here on first sign-in). An
 * account with a stronger guard is refused: a mailbox can change hands (a
 * reassigned Workspace address), and Google's stable sub or the operator's
 * password is what protects that account, so the mailbox alone must not
 * open it.
 */
export async function findOrCreateEmailUser(email: string): Promise<SessionUser> {
  const normalized = email.trim().toLowerCase();
  const existing = await db.user.findUnique({ where: { email: normalized } });
  if (existing) {
    const other = otherSignIn(existing);
    if (other) throw new NoEmailSignInError(other);
    return { id: existing.id, email: existing.email };
  }
  try {
    const created = await db.user.create({
      data: { email: normalized, baseCurrency: "EUR", timezone: "UTC" },
    });
    notifySignup(created.email, "email");
    return { id: created.id, email: created.email };
  } catch (e) {
    // Two first sign-ins of the same address raced: the other one created it.
    const raced = await db.user.findUnique({ where: { email: normalized } });
    if (!raced) throw e;
    const other = otherSignIn(raced);
    if (other) throw new NoEmailSignInError(other);
    return { id: raced.id, email: raced.email };
  }
}

/** The way this address signs in instead of an email code, if any (for the email's wording). */
export async function emailSignInBlocked(email: string): Promise<OtherSignIn | null> {
  const user = await db.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { googleSub: true, passwordHash: true },
  });
  return user ? otherSignIn(user) : null;
}

export async function verifyLogin(email: string, password: string): Promise<SessionUser | null> {
  const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user?.passwordHash) return null;
  const ok = await Bun.password.verify(password, user.passwordHash).catch(() => false);
  return ok ? { id: user.id, email: user.email } : null;
}
