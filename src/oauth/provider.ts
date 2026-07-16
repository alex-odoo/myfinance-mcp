import { randomBytes } from "node:crypto";
import { Router, urlencoded, type Response } from "express";
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
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { OAuthStore } from "./store";
import { loginPage } from "./login";
import { verifyLogin, findOrCreateGoogleUser, type SessionUser } from "../users";
import { config } from "../config";

const ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

interface PendingAuthRequest {
  clientId: string;
  clientName?: string;
  params: AuthorizationParams;
  expiresAt: number;
}

function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("malformed jwt");
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
}

/**
 * OAuth 2.1 provider. Login is checked against the users table (M1: the one
 * bootstrapped account; signup comes later). Pending auth requests and login
 * rate limits are in-memory (single instance, short TTL); everything durable
 * lives in Supabase via OAuthStore.
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
          ...client,
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
    const requestId = newSecret(16);
    this.prunePending();
    this.pending.set(requestId, {
      clientId: client.client_id,
      clientName: client.client_name,
      params,
      expiresAt: Date.now() + AUTH_REQUEST_TTL_MS,
    });
    res.status(200).type("html").send(loginPage(requestId, client.client_name));
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

      const { request_id: requestId, email, password } = req.body as Record<string, string>;
      const pendingReq = requestId ? this.pending.get(requestId) : undefined;
      if (!pendingReq || pendingReq.expiresAt < Date.now()) {
        res.status(400).type("html").send(loginPage("", undefined, "Sign-in request expired. Retry from your AI client."));
        return;
      }

      const user = await verifyLogin(email ?? "", password ?? "");
      if (!user) {
        this.recordFailedLogin(ip);
        res.status(401).type("html").send(loginPage(requestId!, pendingReq.clientName, "Wrong email or password."));
        return;
      }

      await this.finishLogin(requestId!, pendingReq, user.id, res);
    });

    router.get("/auth/google", (req, res) => {
      if (!config.googleClientId || !config.googleClientSecret) {
        res.status(404).send("Google sign-in is not configured");
        return;
      }
      const requestId = String(req.query.request_id ?? "");
      const pendingReq = requestId ? this.pending.get(requestId) : undefined;
      if (!pendingReq || pendingReq.expiresAt < Date.now()) {
        res.status(400).type("html").send(loginPage("", undefined, "Sign-in request expired. Retry from your AI client."));
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
      const pendingReq = stateRec ? this.pending.get(stateRec.requestId) : undefined;
      if (!stateRec || stateRec.expiresAt < Date.now() || !pendingReq || pendingReq.expiresAt < Date.now()) {
        res.status(400).type("html").send(loginPage("", undefined, "Sign-in request expired. Retry from your AI client."));
        return;
      }
      const code = String(req.query.code ?? "");
      if (!code) {
        res.status(400).type("html").send(loginPage(stateRec.requestId, pendingReq.clientName, "Google sign-in was cancelled."));
        return;
      }
      try {
        const user = await this.googleUserFromCode(code);
        await this.finishLogin(stateRec.requestId, pendingReq, user.id, res);
      } catch (err) {
        console.error("google sign-in failed:", err instanceof Error ? err.message : String(err));
        this.recordFailedLogin(req.ip ?? "unknown");
        res.status(401).type("html").send(
          loginPage(stateRec.requestId, pendingReq.clientName, "Google sign-in failed. Try again or use email and password.")
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
    await this.store.deleteCode(authorizationCode);
    return this.issueTokens(client.client_id, record.scopes, record.userId, resource?.href ?? record.resource);
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
    await this.store.deleteRefreshToken(refreshToken);
    void this.store.pruneExpired();
    return this.issueTokens(
      client.client_id,
      scopes?.length ? scopes : record.scopes,
      record.userId,
      resource?.href ?? record.resource
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = await this.store.getToken(token);
    if (!record) throw new InvalidTokenError("Invalid or expired access token");
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

  private async issueTokens(
    clientId: string,
    scopes: string[],
    userId: string,
    resource?: string
  ): Promise<OAuthTokens> {
    const accessToken = newSecret();
    const refreshToken = newSecret();
    await this.store.saveToken(accessToken, {
      clientId,
      scopes,
      userId,
      resource,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    });
    await this.store.saveRefreshToken(refreshToken, {
      clientId,
      scopes,
      userId,
      resource,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
    });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: scopes.join(" ") || undefined,
    };
  }

  private prunePending(): void {
    const now = Date.now();
    for (const [id, req] of this.pending) if (req.expiresAt < now) this.pending.delete(id);
  }

  private pruneGoogleStates(): void {
    const now = Date.now();
    for (const [state, rec] of this.googleStates) if (rec.expiresAt < now) this.googleStates.delete(state);
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
