import { createSign, createHash } from "node:crypto";
import { config } from "../config";

/**
 * Enable Banking API client (AISP, read-only). Auth = RS256 JWT signed with the
 * application's private key; the app id is the JWT kid. Docs: enablebanking.com/docs.
 * The user-facing flow: POST /auth -> user approves at the bank -> redirect to
 * our callback with ?code -> POST /sessions -> per-account transaction pulls.
 */

export interface EbAspsp {
  name: string;
  country: string;
  logo?: string;
  psu_types?: string[];
  maximum_consent_validity?: number; // seconds
}

export interface EbAccount {
  // Valid only while its session is AUTHORIZED: every consent renewal issues
  // new uids. Absent when the bank says the account cannot be read (blocked, closed).
  uid?: string | null;
  // Stable across sessions (and PSUs): the key for matching an account after a
  // consent renewal. Hash of the account identifiers, not the IBAN itself.
  identification_hash?: string | null;
  name?: string | null;
  details?: string | null;
  product?: string | null;
  currency?: string | null;
  account_id?: { iban?: string | null; other?: { identification?: string } | null } | null;
  cash_account_type?: string | null;
}

export interface EbSession {
  session_id: string;
  accounts: EbAccount[];
  aspsp: { name: string; country: string };
  access: { valid_until: string };
}

export interface EbAmount {
  currency: string;
  amount: string; // decimal string
}

export interface EbTransaction {
  entry_reference?: string | null;
  transaction_amount: EbAmount;
  credit_debit_indicator: "CRDT" | "DBIT";
  status: "BOOK" | "PDNG" | string;
  booking_date?: string | null; // YYYY-MM-DD
  value_date?: string | null;
  transaction_date?: string | null;
  creditor?: { name?: string | null } | null;
  debtor?: { name?: string | null } | null;
  remittance_information?: string[] | null;
  merchant_category_code?: string | null;
}

export interface EbTransactionsPage {
  transactions: EbTransaction[];
  continuation_key?: string | null;
}

export interface EbBalance {
  name?: string;
  balance_type?: string; // CLBD closing booked, XPCD expected, ...
  balance_amount: EbAmount;
}

/** The bank or the user ended access (expired, revoked, closed consent): only a reconnect fixes it. */
export class EbAuthError extends Error {}
/** Enable Banking rejected OUR application credentials: an operator problem, never the user's consent. */
export class EbAppAuthError extends Error {}
/** The bank throttles unattended access (PSD2: typically 4 pulls a day); EB advises waiting 6 hours. */
export class EbRateLimitError extends Error {}
/** 400/422: the request itself was refused; repeating it unchanged does not help. */
export class EbRequestError extends Error {}

// 401 is not only an ended consent: a broken application key or JWT answers 401
// too, and EB's FAQ says to branch on the error code, not the status. These
// codes are the user's session; anything else is settled by asking GET
// /application (no bank involved) whether our own credentials still work.
const SESSION_ERRORS = new Set(["EXPIRED_SESSION", "CLOSED_SESSION", "REVOKED_SESSION"]);

async function errorBody(res: Response): Promise<{ code?: string; message?: string }> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as { error?: unknown; message?: unknown };
    return {
      code: typeof j.error === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(j.error) ? j.error : undefined,
      message: typeof j.message === "string" ? j.message.slice(0, 160) : undefined,
    };
  } catch {
    return {};
  }
}

/** true = our credentials are rejected, false = they work, undefined = could not tell. */
async function appCredentialsRejected(): Promise<boolean | undefined> {
  try {
    const res = await fetch(`${config.ebApiOrigin}/application`, {
      headers: { authorization: `Bearer ${ebJwt()}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return false;
    return res.status === 401 || res.status === 403 ? true : undefined;
  } catch {
    return undefined;
  }
}

export function ebConfigured(): boolean {
  return !!(config.ebAppId && config.ebPrivateKeyB64);
}

let jwtCache: { token: string; exp: number } | null = null;

function ebJwt(): string {
  if (jwtCache && jwtCache.exp - 60 > Date.now() / 1000) return jwtCache.token;
  const keyPem = Buffer.from(config.ebPrivateKeyB64, "base64").toString("utf8");
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600;
  const b64url = (s: Buffer | string) => Buffer.from(s).toString("base64url");
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid: config.ebAppId }));
  const payload = b64url(JSON.stringify({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp }));
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(keyPem);
  jwtCache = { token: `${header}.${payload}.${b64url(sig)}`, exp };
  return jwtCache.token;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!ebConfigured()) {
    throw new Error("Bank connections are not configured on this server (EB_APP_ID / EB_PRIVATE_KEY_B64 missing).");
  }
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${config.ebApiOrigin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${ebJwt()}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 401 || res.status === 403) {
        const { code } = await errorBody(res);
        const tag = `${res.status}${code ? ` ${code}` : ""}`;
        if (!SESSION_ERRORS.has(code ?? "")) {
          const appRejected = await appCredentialsRejected();
          if (appRejected) {
            throw new EbAppAuthError(
              `Enable Banking rejected this server's application credentials (${tag}). Nothing to do on the user's side; syncing resumes once the server is fixed.`
            );
          }
          if (appRejected === undefined) {
            lastError = `Enable Banking API returned ${tag}, credentials check inconclusive`;
            break; // cannot tell whose access failed: transient, never a sticky consent error
          }
        }
        throw new EbAuthError(
          `Bank access was rejected (${tag}). The consent has expired or was revoked - reconnect with connect_bank action=start.`
        );
      }
      if (res.status === 429) {
        const { code } = await errorBody(res);
        throw new EbRateLimitError(
          `The bank is rate-limiting data access (${code ?? "429"}); banks allow about 4 background pulls a day. The next automatic sync waits 6 hours.`
        );
      }
      if (res.status === 422 || res.status === 400) {
        const { code, message } = await errorBody(res);
        throw new EbRequestError(`Enable Banking rejected the request: ${[code, message].filter(Boolean).join(" ") || res.status}`);
      }
      if (!res.ok) {
        lastError = `Enable Banking API returned ${res.status}`;
        continue; // retry once on 5xx
      }
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof EbAuthError || e instanceof EbAppAuthError || e instanceof EbRateLimitError || e instanceof EbRequestError) {
        throw e;
      }
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`Enable Banking API unreachable (${lastError}). Try again later.`);
}

export async function ebAspsps(country?: string): Promise<EbAspsp[]> {
  const q = country ? `?country=${encodeURIComponent(country.toUpperCase())}` : "";
  const data = await api<{ aspsps: EbAspsp[] }>("GET", `/aspsps${q}`);
  return data.aspsps ?? [];
}

export async function ebStartAuth(opts: {
  aspspName: string;
  country: string;
  state: string;
  validUntil: string; // ISO
}): Promise<{ url: string }> {
  return api<{ url: string }>("POST", "/auth", {
    access: { valid_until: opts.validUntil },
    aspsp: { name: opts.aspspName, country: opts.country.toUpperCase() },
    state: opts.state,
    redirect_url: `${config.baseUrl}/connect/enablebanking/callback`,
    psu_type: "personal",
  });
}

export async function ebCreateSession(code: string): Promise<EbSession> {
  return api<EbSession>("POST", "/sessions", { code });
}

export async function ebDeleteSession(sessionId: string): Promise<void> {
  try {
    await api("DELETE", `/sessions/${encodeURIComponent(sessionId)}`);
  } catch {
    // Best effort: consent expires on its own; local disconnect must not fail on it.
  }
}

export async function ebTransactions(
  accountUid: string,
  opts: { dateFrom?: string; dateTo?: string; continuationKey?: string } = {}
): Promise<EbTransactionsPage> {
  const params = new URLSearchParams();
  if (opts.dateFrom) params.set("date_from", opts.dateFrom);
  if (opts.dateTo) params.set("date_to", opts.dateTo);
  if (opts.continuationKey) params.set("continuation_key", opts.continuationKey);
  const qs = params.toString();
  return api<EbTransactionsPage>("GET", `/accounts/${encodeURIComponent(accountUid)}/transactions${qs ? `?${qs}` : ""}`);
}

export async function ebBalances(accountUid: string): Promise<EbBalance[]> {
  const data = await api<{ balances: EbBalance[] }>("GET", `/accounts/${encodeURIComponent(accountUid)}/balances`);
  return data.balances ?? [];
}

/**
 * Stable fallback id for banks that omit entry_reference. accountKey is the
 * uid the account had at FIRST link (not the current session's), so ids
 * survive consent renewals. Two genuinely identical rows share it: the sync
 * numbers repeats within one fetch (id, id:2, id:3).
 */
export function ebDerivedId(accountKey: string, t: EbTransaction): string {
  const basis = [
    accountKey,
    t.booking_date ?? t.transaction_date ?? "",
    t.transaction_amount.amount,
    t.transaction_amount.currency,
    t.credit_debit_indicator,
    (t.remittance_information ?? []).join(" "),
    t.creditor?.name ?? t.debtor?.name ?? "",
  ].join("|");
  return createHash("sha256").update(basis).digest("hex").slice(0, 24);
}
