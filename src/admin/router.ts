import { randomBytes, timingSafeEqual } from "node:crypto";
import { Router, urlencoded, type NextFunction, type Request, type Response } from "express";
import { config } from "../config";
import { logEvent } from "../db";
import { maskEmail } from "../oauth/login";
import { GOOGLE_CALLBACK_PATH, googleConsentUrl, googleIdentityFromCode } from "../oauth/google";
import { pruneMap, readCookie, sha256 } from "../httpUtil";
import { adminStats } from "./stats";
import { adminDashboardPage, adminSignInPage } from "./page";

/**
 * /admin: the operator overview. Google sign-in only, open to ADMIN_EMAILS.
 * It shares the one Google redirect URI with the connector sign-in: the
 * callback below answers the states it issued (prefix "adm.") and passes
 * every other one on to the OAuth provider. Signing in here never creates a
 * MyFinance account. Sessions live in memory, so a deploy signs the operator out.
 */

const SESSION_COOKIE = "mf_admin";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 20;

// The state is "adm.<issued, base36 ms>.<nonce>" and the nonce also goes to
// a cookie: the Google leg must come back to the browser that started it.
// Nothing is kept on the server, so no flood of /admin/login (it is
// unauthenticated) can push the operator's sign-in out of memory. A replay
// of the callback finds Google's code already spent. One cookie per sign-in
// (its name carries the nonce's head), so two tabs do not void each other.
const STATE_PREFIX = "adm.";
const STATE_COOKIE_PREFIX = "mf_admin_st_";
const stateCookie = (nonce: string) => `${STATE_COOKIE_PREFIX}${nonce.slice(0, 12)}`;
const STATE_TTL_MS = 10 * 60 * 1000;

// Failed sign-ins (a code Google refuses, an address not on the list) per IP.
const FAILURES_MAX = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_IPS = 10_000;

const sessions = new Map<string, { email: string; expiresAt: number }>();
const failures = new Map<string, { count: number; expiresAt: number }>();

// The page holds every user's email: never cached, framed or indexed. No
// script runs on it at all. Referrer same-origin, not no-referrer: under
// no-referrer a browser sends "Origin: null" with the Sign out form, and the
// origin check below would refuse it.
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
const TOO_MANY = "Too many failed sign-ins from this network. Try again in 15 minutes.";

const secure = () => config.baseUrl.startsWith("https");

export function adminEnabled(): boolean {
  return config.adminEmails.length > 0 && !!config.googleClientId && !!config.googleClientSecret;
}

function throttled(ip: string): boolean {
  const f = failures.get(ip);
  return !!f && f.expiresAt >= Date.now() && f.count >= FAILURES_MAX;
}

function recordFailure(ip: string): void {
  const now = Date.now();
  const f = failures.get(ip);
  if (f && f.expiresAt >= now) {
    f.count++;
    return;
  }
  if (failures.size >= MAX_TRACKED_IPS) {
    // Room goes first from addresses that are not locked out, so a flood of
    // new addresses cannot release one that is.
    for (const [key, entry] of failures) {
      if (failures.size < MAX_TRACKED_IPS) break;
      if (entry.expiresAt < now || entry.count < FAILURES_MAX) failures.delete(key);
    }
    pruneMap(failures, MAX_TRACKED_IPS);
  }
  failures.set(ip, { count: 1, expiresAt: now + FAILURE_WINDOW_MS });
}

function sessionOf(req: Request): { key: string; email: string } | undefined {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return undefined;
  const key = sha256(token).toString("hex");
  const session = sessions.get(key);
  if (!session || session.expiresAt < Date.now() || !config.adminEmails.includes(session.email)) {
    sessions.delete(key);
    return undefined;
  }
  return { key, email: session.email };
}

function signedOut(res: Response, status: number, error?: string): void {
  res.status(status).set(SECURITY_HEADERS).type("html").send(adminSignInPage(error));
}

export function adminRouter(): Router {
  const router = Router();
  const canonicalHost = new URL(config.baseUrl).hostname;

  router.use("/admin", (req, res, next) => {
    if (!adminEnabled()) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    // Cookies live on the canonical host, which is where Google returns to.
    if (req.hostname !== canonicalHost) {
      res.redirect(307, `${config.baseUrl}${req.originalUrl}`);
      return;
    }
    res.set(SECURITY_HEADERS);
    next();
  });

  router.get("/admin", async (req, res) => {
    const session = sessionOf(req);
    if (!session) return signedOut(res, 401);
    try {
      res.type("html").send(adminDashboardPage(await adminStats(), session.email));
    } catch (err) {
      console.error("[admin] stats failed:", err instanceof Error ? err.message : String(err));
      res.status(500).type("text/plain").send("Could not load the overview. Reload in a minute.");
    }
  });

  router.get("/admin/login", (req, res) => {
    if (throttled(req.ip ?? "unknown")) return signedOut(res, 429, TOO_MANY);
    const nonce = randomBytes(32).toString("base64url");
    res.cookie(stateCookie(nonce), nonce, {
      httpOnly: true,
      sameSite: "lax", // Google's redirect back is a top-level GET
      secure: secure(),
      path: GOOGLE_CALLBACK_PATH,
      maxAge: STATE_TTL_MS,
    });
    res.redirect(302, googleConsentUrl(`${STATE_PREFIX}${Date.now().toString(36)}.${nonce}`));
  });

  router.post("/admin/logout", urlencoded({ extended: false }), (req, res) => {
    // SameSite=Lax already keeps the cookie off cross-site POSTs; a foreign
    // Origin is refused outright.
    const origin = req.get("origin");
    if (origin && origin !== new URL(config.baseUrl).origin) {
      res.status(403).type("text/plain").send("Forbidden");
      return;
    }
    const session = sessionOf(req);
    if (session) sessions.delete(session.key);
    res.clearCookie(SESSION_COOKIE, { path: "/admin", httpOnly: true, sameSite: "lax", secure: secure() });
    res.redirect(303, "/admin");
  });

  return router;
}

/**
 * GET GOOGLE_CALLBACK_PATH, ahead of the OAuth provider's handler. Answers
 * every "adm." state, expired ones included; anything else goes on to the
 * provider.
 */
export async function adminGoogleCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!state.startsWith(STATE_PREFIX)) return next();
  res.set(SECURITY_HEADERS);
  if (!adminEnabled()) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  const ip = req.ip ?? "unknown";
  const [, issued, nonce] = state.split(".");
  if (nonce) res.clearCookie(stateCookie(nonce), { path: GOOGLE_CALLBACK_PATH, httpOnly: true, sameSite: "lax", secure: secure() });
  const issuedAt = parseInt(issued ?? "", 36);
  const age = Date.now() - issuedAt;
  if (!nonce || !Number.isFinite(issuedAt) || age > STATE_TTL_MS || age < -60_000) {
    return signedOut(res, 400, "The sign-in expired. Try again.");
  }
  const browserKey = readCookie(req, stateCookie(nonce));
  if (!browserKey || !timingSafeEqual(sha256(browserKey), sha256(nonce))) {
    return signedOut(res, 400, "This sign-in was started in a different browser. Try again.");
  }
  if (throttled(ip)) return signedOut(res, 429, TOO_MANY);
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code) return signedOut(res, 400, "Google sign-in was cancelled.");

  let email: string;
  try {
    email = (await googleIdentityFromCode(code)).email.toLowerCase();
  } catch (err) {
    recordFailure(ip);
    console.error("[admin] google sign-in failed:", err instanceof Error ? err.message : String(err));
    return signedOut(res, 401, "Google sign-in failed. Try again.");
  }
  if (!config.adminEmails.includes(email)) {
    recordFailure(ip);
    console.error(`[admin] refused ${maskEmail(email)}: not on ADMIN_EMAILS`);
    logEvent("admin_signin", undefined, { allowed: false });
    return signedOut(res, 403, "This Google account has no access to the admin page.");
  }

  pruneMap(sessions, MAX_SESSIONS);
  const token = randomBytes(32).toString("base64url");
  sessions.set(sha256(token).toString("hex"), { email, expiresAt: Date.now() + SESSION_TTL_MS });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secure(),
    path: "/admin",
    maxAge: SESSION_TTL_MS,
  });
  console.log(`[admin] signed in ${maskEmail(email)}`);
  logEvent("admin_signin", undefined, { allowed: true });
  res.redirect(303, "/admin");
}
