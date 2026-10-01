import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, urlencoded, type Request, type Response } from "express";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  OAuthError,
  UnsupportedResponseTypeError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { OAuthStore, type IssuedTokens } from "./store";
import { loginPage, type LoginClient } from "./login";
import { verifyLogin, findOrCreateGoogleUser, GoogleAccountConflictError, type SessionUser } from "../users";
import { config } from "../config";

const ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export const SUPPORTED_SCOPES = ["finance"];

// /authorize is unauthenticated and parks each request in memory until
// sign-in, so what one request may hold is capped.
const PENDING_MAX = 5000;
const MAX_STATE_LENGTH = 1024;
const MAX_SCOPE_LENGTH = 256;
// S256 challenge = base64url(sha256(verifier)) without padding: 43 chars.
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

// DCR is anonymous and its rows are permanent, so a registration's size is capped.
const MAX_CLIENT_NAME = 100;
const MAX_LIST_ENTRIES = 10;
const MAX_FIELD_LENGTH = 2048;

// Browser binding. /authorize gives the browser one random id (shared by
// parallel sign-ins) and the pending request keeps its hash; the login POST
// and both Google legs must present it. Without it, a Google link minted for
// someone else's pending request signs in whoever clicks it, and the code
// goes to the link minter's redirect_uri.
const BROWSER_COOKIE = "mf_bid";
const BROWSER_COOKIE_MAX_AGE_MS = 30 * 60 * 1000;
const BROWSER_ID = /^[A-Za-z0-9_-]{43}$/;

const EXPIRED = "Sign-in request expired. Retry from your AI client.";
const DIFFERENT_BROWSER = "This sign-in was started in a different browser. Retry from your AI client.";

interface PendingAuthRequest {
  clientId: string;
  client: LoginClient;
  params: AuthorizationParams;
  browserHash: Buffer;
  expiresAt: number;
}

function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("malformed jwt");
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
}

/** Origin + path without trailing slash; undefined for anything that is not a plain URL. */
function canonicalResource(value: string | URL): string | undefined {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

// RFC 8707 audiences that mean this server: the canonical and legacy origins,
// bare (users paste the bare domain) or with /mcp.
const ALLOWED_RESOURCES = new Set(
  [config.baseUrl, ...config.legacyBaseUrls]
    .flatMap((base) => [base, `${base}/mcp`])
    .map((url) => canonicalResource(url))
    .filter((url): url is string => url !== undefined)
);

function isAllowedResource(value: string | URL): boolean {
  const canonical = canonicalResource(value);
  return canonical !== undefined && ALLOWED_RESOURCES.has(canonical);
}

/** Scopes this server knows; anything else is dropped, never stored. */
function knownScopes(scopes: string[] | undefined): string[] {
  return [...new Set(scopes ?? [])].filter((s) => SUPPORTED_SCOPES.includes(s));
}

/**
 * Size and audience limits on an authorization request. Shared by
 * authorize() and the /authorize pre-check in index.ts (via
 * authorizeRequestProblem), which reports a failure as a 400 page instead of
 * the SDK's redirect to the client.
 */
function checkAuthorizationParams(p: {
  codeChallenge: string;
  state?: string;
  scope?: string;
  resource?: string;
}): void {
  if (!S256_CHALLENGE.test(p.codeChallenge)) {
    throw new InvalidRequestError("code_challenge must be an S256 PKCE challenge");
  }
  if ((p.state?.length ?? 0) > MAX_STATE_LENGTH) {
    throw new InvalidRequestError(`state is longer than ${MAX_STATE_LENGTH} characters`);
  }
  if ((p.scope?.length ?? 0) > MAX_SCOPE_LENGTH) {
    throw new InvalidRequestError(`scope is longer than ${MAX_SCOPE_LENGTH} characters`);
  }
  if (p.resource !== undefined && !isAllowedResource(p.resource)) {
    throw new InvalidTargetError("resource is not this server");
  }
}

/** The SDK's second-phase /authorize checks on the raw query or form, plus ours. */
export function authorizeRequestProblem(q: Record<string, unknown>): OAuthError | undefined {
  const keys = ["response_type", "code_challenge", "code_challenge_method", "scope", "state", "resource"];
  const repeated = keys.find((key) => q[key] !== undefined && typeof q[key] !== "string");
  if (repeated) return new InvalidRequestError(`${repeated} must be a single value`);
  const str = (key: string) => q[key] as string | undefined;
  if (str("response_type") !== "code") return new UnsupportedResponseTypeError("response_type must be code");
  if (str("code_challenge_method") !== "S256") return new InvalidRequestError("code_challenge_method must be S256");
  try {
    checkAuthorizationParams({
      codeChallenge: str("code_challenge") ?? "",
      state: str("state"),
      scope: str("scope"),
      resource: str("resource"),
    });
  } catch (e) {
    if (e instanceof OAuthError) return e;
    throw e;
  }
  return undefined;
}

type RegisteredClient = Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">;

/** Caps what one anonymous registration can store; key material is never kept. */
function storableClientMetadata(client: RegisteredClient): RegisteredClient {
  const { jwks: _jwks, jwks_uri: _jwksUri, software_statement: _statement, contacts: _contacts, ...kept } = client;
  if ((kept.client_name?.length ?? 0) > MAX_CLIENT_NAME) {
    throw new InvalidClientMetadataError(`client_name is longer than ${MAX_CLIENT_NAME} characters`);
  }
  for (const [key, value] of Object.entries(kept)) {
    const values: unknown[] = Array.isArray(value) ? value : [value];
    if (values.length > MAX_LIST_ENTRIES) {
      throw new InvalidClientMetadataError(`${key} has more than ${MAX_LIST_ENTRIES} entries`);
    }
    if (values.some((v) => typeof v === "string" && v.length > MAX_FIELD_LENGTH)) {
      throw new InvalidClientMetadataError(`${key} is longer than ${MAX_FIELD_LENGTH} characters`);
    }
  }
  return kept;
}

/**
 * OAuth 2.1 provider. Sign-in is Google (an account is created on first
 * sign-in) or email + password (only the env-bootstrapped operator account
 * has a password). Pending auth requests and login rate limits are in-memory
 * (single instance, short TTL); everything durable lives in Supabase via
 * OAuthStore.
 */
export class FinanceOAuthProvider implements OAuthServerProvider {
  private readonly pending = new Map<string, PendingAuthRequest>();
  private readonly loginAttempts = new Map<string, { count: number; resetAt: number }>();
  /** Google OIDC state -> our pending auth request (CSRF binding). */
  private readonly googleStates = new Map<string, { requestId: string; expiresAt: number }>();

  constructor(private readonly store: OAuthStore) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.store.getClient(clientId),
      registerClient: async (client) => {
        const full: OAuthClientInformationFull = {
          ...storableClientMetadata(client),
          client_id: newSecret(16),
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        await this.store.saveClient(full);
        return full;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    checkAuthorizationParams({
      codeChallenge: params.codeChallenge,
      state: params.state,
      scope: params.scopes?.join(" "),
      resource: params.resource?.href,
    });
    // Rows registered before the metadata caps can hold huge values; none of
    // them reaches memory or the page. A 400 here, not a redirect to that URI.
    if (params.redirectUri.length > MAX_FIELD_LENGTH) {
      res
        .status(400)
        .type("html")
        .send(loginPage("", undefined, "This client's registration is invalid. Reconnect from your AI client."));
      return;
    }

    const existing = readCookie(res.req, BROWSER_COOKIE);
    const browserId = existing && BROWSER_ID.test(existing) ? existing : newSecret();
    res.cookie(BROWSER_COOKIE, browserId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: BROWSER_COOKIE_MAX_AGE_MS,
      secure: config.baseUrl.startsWith("https"),
    });

    const requestId = newSecret(16);
    const loginClient: LoginClient = {
      name: client.client_name?.slice(0, MAX_CLIENT_NAME),
      redirectUri: params.redirectUri,
    };
    this.prunePending();
    this.pending.set(requestId, {
      clientId: client.client_id,
      client: loginClient,
      // Unknown scopes are dropped rather than refused: clients send odd ones.
      params: { ...params, scopes: knownScopes(params.scopes) },
      browserHash: sha256(browserId),
      expiresAt: Date.now() + AUTH_REQUEST_TTL_MS,
    });
    res.status(200).type("html").send(loginPage(requestId, loginClient));
  }

  /** Express router with the login form POST target. Mount at app root. */
  loginRouter(): Router {
    const router = Router();
    router.post("/login", urlencoded({ extended: false }), async (req, res) => {
      const ip = req.ip ?? "unknown";
      if (this.isRateLimited(ip)) {
        res.status(429).type("html").send(loginPage("", undefined, "Too many attempts. Try again later."));
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const field = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : "");
      const requestId = field("request_id");
      const pendingReq = this.livePending(requestId);
      if (!pendingReq) {
        res.status(400).type("html").send(loginPage("", undefined, EXPIRED));
        return;
      }
      if (!this.sameBrowser(req, pendingReq)) {
        res.status(400).type("html").send(loginPage("", undefined, DIFFERENT_BROWSER));
        return;
      }

      const user = await verifyLogin(field("email"), field("password"));
      if (!user) {
        this.recordFailedLogin(ip);
        res.status(401).type("html").send(loginPage(requestId, pendingReq.client, "Wrong email or password."));
        return;
      }

      await this.finishLogin(requestId, pendingReq, user.id, res);
    });

    router.get("/auth/google", (req, res) => {
      if (!config.googleClientId || !config.googleClientSecret) {
        res.status(404).send("Google sign-in is not configured");
        return;
      }
      const requestId = String(req.query.request_id ?? "");
      const pendingReq = this.livePending(requestId);
      if (!pendingReq) {
        res.status(400).type("html").send(loginPage("", undefined, EXPIRED));
        return;
      }
      if (!this.sameBrowser(req, pendingReq)) {
        res.status(400).type("html").send(loginPage("", undefined, DIFFERENT_BROWSER));
        return;
      }
      this.pruneGoogleStates();
      const state = newSecret();
      this.googleStates.set(state, { requestId, expiresAt: Date.now() + AUTH_REQUEST_TTL_MS });

      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", config.googleClientId);
      url.searchParams.set("redirect_uri", `${config.baseUrl}/auth/google/callback`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid email");
      url.searchParams.set("state", state);
      url.searchParams.set("prompt", "select_account");
      res.redirect(302, url.href);
    });

    router.get("/auth/google/callback", async (req, res) => {
      if (!config.googleClientId || !config.googleClientSecret) {
        res.status(404).send("Google sign-in is not configured");
        return;
      }
      const state = String(req.query.state ?? "");
      const stateRec = state ? this.googleStates.get(state) : undefined;
      if (stateRec) this.googleStates.delete(state); // single-use
      const pendingReq = stateRec && stateRec.expiresAt >= Date.now() ? this.livePending(stateRec.requestId) : undefined;
      if (!stateRec || !pendingReq) {
        res.status(400).type("html").send(loginPage("", undefined, EXPIRED));
        return;
      }
      // Google's redirect back is a top-level GET, so the SameSite=Lax cookie
      // arrives here only in the browser that started this sign-in.
      if (!this.sameBrowser(req, pendingReq)) {
        res.status(400).type("html").send(loginPage("", undefined, DIFFERENT_BROWSER));
        return;
      }
      const code = String(req.query.code ?? "");
      if (!code) {
        res.status(400).type("html").send(loginPage(stateRec.requestId, pendingReq.client, "Google sign-in was cancelled."));
        return;
      }
      try {
        const user = await this.googleUserFromCode(code);
        await this.finishLogin(stateRec.requestId, pendingReq, user.id, res);
      } catch (err) {
        console.error("google sign-in failed:", err instanceof Error ? err.message : String(err));
        this.recordFailedLogin(req.ip ?? "unknown");
        if (err instanceof GoogleAccountConflictError) {
          res.status(409).type("html").send(
            loginPage(stateRec.requestId, pendingReq.client, "This email is already linked to a different Google account.")
          );
          return;
        }
        res.status(401).type("html").send(
          loginPage(stateRec.requestId, pendingReq.client, "Google sign-in failed. Try again or use email and password.")
        );
      }
    });

    return router;
  }

  /** Exchange the Google authorization code and provision/find the user. */
  private async googleUserFromCode(code: string): Promise<SessionUser> {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        redirect_uri: `${config.baseUrl}/auth/google/callback`,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) throw new Error(`google token endpoint returned ${tokenRes.status}`);
    const tokens = (await tokenRes.json()) as { id_token?: string };
    if (!tokens.id_token) throw new Error("google response missing id_token");

    // The id_token arrived directly from Google's token endpoint over TLS,
    // so claim validation (not signature verification) is what matters here.
    const claims = decodeJwtPayload(tokens.id_token) as {
      iss?: string; aud?: string; exp?: number; sub?: string; email?: string; email_verified?: boolean;
    };
    if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
      throw new Error("id_token issuer mismatch");
    }
    if (claims.aud !== config.googleClientId) throw new Error("id_token audience mismatch");
    if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) throw new Error("id_token expired");
    if (!claims.sub) throw new Error("id_token missing sub");
    if (!claims.email || claims.email_verified !== true) throw new Error("google email not verified");

    return findOrCreateGoogleUser(claims.email, claims.sub);
  }

  /** Consume the pending auth request: issue our code and send the user back to the MCP client. */
  private async finishLogin(
    requestId: string,
    pendingReq: PendingAuthRequest,
    userId: string,
    res: Response
  ): Promise<void> {
    this.pending.delete(requestId);
    const code = newSecret();
    await this.store.saveCode(code, {
      clientId: pendingReq.clientId,
      codeChallenge: pendingReq.params.codeChallenge,
      redirectUri: pendingReq.params.redirectUri,
      scopes: pendingReq.params.scopes ?? [],
      resource: pendingReq.params.resource?.href,
      userId,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const redirect = new URL(pendingReq.params.redirectUri);
    redirect.searchParams.set("code", code);
    if (pendingReq.params.state) redirect.searchParams.set("state", pendingReq.params.state);
    res.redirect(302, redirect.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const record = await this.store.getCode(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const record = await this.store.getCode(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    if (redirectUri && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match authorization request");
    }
    const tokens = this.newTokens(
      client.client_id,
      record.userId,
      record.scopes,
      record.scopes,
      bindResource(record.resource, resource)
    );
    await this.store.redeemCode(authorizationCode, client.client_id, tokens);
    return tokenResponse(tokens);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const record = await this.store.getRefreshToken(refreshToken);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    // RFC 6749 section 6: a refresh may narrow the grant, never widen it.
    // Scopes this server does not know grant nothing and are ignored, as at
    // /authorize (a client may repeat the odd scope it asked for there).
    const requested = knownScopes(scopes);
    if (requested.some((s) => !record.scopes.includes(s))) {
      throw new InvalidScopeError("Requested scope exceeds the original grant");
    }
    // A narrower request applies to the access token; the refresh token keeps
    // the original grant (RFC 6749 section 6).
    const tokens = this.newTokens(
      client.client_id,
      record.userId,
      requested.length ? requested : record.scopes,
      record.scopes,
      bindResource(record.resource, resource)
    );
    await this.store.rotateRefreshToken(refreshToken, client.client_id, tokens);
    void this.store.pruneExpired().catch((e: unknown) => {
      console.error("[oauth] prune failed:", e instanceof Error ? e.message : String(e));
    });
    return tokenResponse(tokens);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = await this.store.getToken(token);
    if (!record) throw new InvalidTokenError("Invalid or expired access token");
    // RFC 8707 audience check: a token minted for another server is not
    // accepted here (confused deputy). Tokens issued without one still work.
    if (record.resource && !isAllowedResource(record.resource)) {
      throw new InvalidTokenError("Access token was issued for a different resource");
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: record.resource ? new URL(record.resource) : undefined,
      extra: { userId: record.userId },
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    const access = await this.store.getToken(request.token);
    if (access && access.clientId === client.client_id) await this.store.deleteToken(request.token);
    const refresh = await this.store.getRefreshToken(request.token);
    if (refresh && refresh.clientId === client.client_id) await this.store.deleteRefreshToken(request.token);
  }

  private newTokens(
    clientId: string,
    userId: string,
    scopes: string[],
    refreshScopes: string[],
    resource?: string
  ): IssuedTokens {
    const now = Date.now();
    return {
      accessToken: newSecret(),
      refreshToken: newSecret(),
      access: { clientId, scopes, userId, resource, expiresAt: now + ACCESS_TOKEN_TTL_MS },
      refresh: { clientId, scopes: refreshScopes, userId, resource, expiresAt: now + REFRESH_TOKEN_TTL_MS },
    };
  }

  private livePending(requestId: string): PendingAuthRequest | undefined {
    const pendingReq = requestId ? this.pending.get(requestId) : undefined;
    return pendingReq && pendingReq.expiresAt >= Date.now() ? pendingReq : undefined;
  }

  /** Constant-time check that this request comes from the browser that started the sign-in. */
  private sameBrowser(req: Request, pendingReq: PendingAuthRequest): boolean {
    const browserId = readCookie(req, BROWSER_COOKIE);
    return !!browserId && timingSafeEqual(sha256(browserId), pendingReq.browserHash);
  }

  private prunePending(): void {
    const now = Date.now();
    for (const [id, req] of this.pending) if (req.expiresAt < now) this.pending.delete(id);
    // Map order is insertion order: past the cap the oldest requests go first.
    for (const id of this.pending.keys()) {
      if (this.pending.size < PENDING_MAX) break;
      this.pending.delete(id);
    }
  }

  private pruneGoogleStates(): void {
    const now = Date.now();
    for (const [state, rec] of this.googleStates) if (rec.expiresAt < now) this.googleStates.delete(state);
    for (const state of this.googleStates.keys()) {
      if (this.googleStates.size < PENDING_MAX) break;
      this.googleStates.delete(state);
    }
  }

  private isRateLimited(ip: string): boolean {
    const entry = this.loginAttempts.get(ip);
    if (!entry || entry.resetAt < Date.now()) return false;
    return entry.count >= LOGIN_MAX_ATTEMPTS;
  }

  private recordFailedLogin(ip: string): void {
    const entry = this.loginAttempts.get(ip);
    if (!entry || entry.resetAt < Date.now()) {
      this.loginAttempts.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
    } else {
      entry.count += 1;
    }
  }
}

/**
 * RFC 8707 at the token endpoint: no resource keeps the authorized one; a
 * named one must be this server and match the authorization. A grant
 * authorized without one (older clients) may be bound to this server now.
 */
function bindResource(stored: string | undefined, requested: URL | undefined): string | undefined {
  if (!requested) return stored;
  if (!isAllowedResource(requested)) throw new InvalidTargetError("resource is not this server");
  if (stored && canonicalResource(stored) !== canonicalResource(requested)) {
    throw new InvalidTargetError("resource does not match the authorization");
  }
  return stored ?? requested.href;
}

function tokenResponse(t: IssuedTokens): OAuthTokens {
  return {
    access_token: t.accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: t.refreshToken,
    scope: t.access.scopes.join(" ") || undefined,
  };
}
