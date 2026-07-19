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
  uid: string;
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

export class EbAuthError extends Error {}

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
        const detail = await res.text().catch(() => "");
        throw new EbAuthError(
          `Bank access was rejected (${res.status}). The consent has likely expired - reconnect with connect_bank action=start. ${detail.slice(0, 200)}`
        );
      }
      if (res.status === 422 || res.status === 400) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Enable Banking rejected the request: ${detail.slice(0, 300)}`);
      }
      if (!res.ok) {
        lastError = `Enable Banking API returned ${res.status}`;
        continue; // retry once on 5xx
      }
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof EbAuthError) throw e;
      if (e instanceof Error && e.message.startsWith("Enable Banking rejected")) throw e;
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
  opts: { dateFrom?: string; continuationKey?: string } = {}
): Promise<EbTransactionsPage> {
  const params = new URLSearchParams();
  if (opts.dateFrom) params.set("date_from", opts.dateFrom);
  if (opts.continuationKey) params.set("continuation_key", opts.continuationKey);
  const qs = params.toString();
  return api<EbTransactionsPage>("GET", `/accounts/${encodeURIComponent(accountUid)}/transactions${qs ? `?${qs}` : ""}`);
}

export async function ebBalances(accountUid: string): Promise<EbBalance[]> {
  const data = await api<{ balances: EbBalance[] }>("GET", `/accounts/${encodeURIComponent(accountUid)}/balances`);
  return data.balances ?? [];
}

/** Stable fallback id for banks that omit entry_reference. */
export function ebDerivedId(accountUid: string, t: EbTransaction): string {
  const basis = [
    accountUid,
    t.booking_date ?? t.transaction_date ?? "",
    t.transaction_amount.amount,
    t.transaction_amount.currency,
    t.credit_debit_indicator,
    (t.remittance_information ?? []).join(" "),
    t.creditor?.name ?? t.debtor?.name ?? "",
  ].join("|");
  return createHash("sha256").update(basis).digest("hex").slice(0, 24);
}
