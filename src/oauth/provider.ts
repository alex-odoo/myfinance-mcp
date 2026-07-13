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
import { OAuthStore } from "./store.js";
import { loginPage } from "./login.js";

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

/**
 * Single-user OAuth 2.1 provider for Gate A. The consent screen doubles as
 * login; credentials come from env (hash verified via Bun.password).
 * Real signup + Supabase-backed users arrive in M1.
 */
export class FinanceOAuthProvider implements OAuthServerProvider {
  private readonly pending = new Map<string, PendingAuthRequest>();
  private readonly loginAttempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly store: OAuthStore,
    private readonly user: { email: string; passwordHash: string }
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.store.getClient(clientId),
      registerClient: (client) => {
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: newSecret(16),
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        this.store.saveClient(full);
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

      const emailOk = (email ?? "").trim().toLowerCase() === this.user.email.toLowerCase();
      const passwordOk = await Bun.password.verify(password ?? "", this.user.passwordHash).catch(() => false);
      if (!emailOk || !passwordOk) {
        this.recordFailedLogin(ip);
        res.status(401).type("html").send(loginPage(requestId!, pendingReq.clientName, "Wrong email or password."));
        return;
      }

      this.pending.delete(requestId!);
      const code = newSecret();
      this.store.saveCode(code, {
        clientId: pendingReq.clientId,
        codeChallenge: pendingReq.params.codeChallenge,
        redirectUri: pendingReq.params.redirectUri,
        scopes: pendingReq.params.scopes ?? [],
        resource: pendingReq.params.resource?.href,
        userId: this.user.email,
        expiresAt: Date.now() + CODE_TTL_MS,
      });

      const redirect = new URL(pendingReq.params.redirectUri);
      redirect.searchParams.set("code", code);
      if (pendingReq.params.state) redirect.searchParams.set("state", pendingReq.params.state);
      res.redirect(302, redirect.href);
    });
    return router;
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const record = this.store.getCode(authorizationCode);
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
    const record = this.store.getCode(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    if (redirectUri && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match authorization request");
    }
    this.store.deleteCode(authorizationCode);
    return this.issueTokens(client.client_id, record.scopes, record.userId, resource?.href ?? record.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const record = this.store.getRefreshToken(refreshToken);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    this.store.deleteRefreshToken(refreshToken);
    return this.issueTokens(
      client.client_id,
      scopes?.length ? scopes : record.scopes,
      record.userId,
      resource?.href ?? record.resource
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.store.getToken(token);
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
    const access = this.store.getToken(request.token);
    if (access && access.clientId === client.client_id) this.store.deleteToken(request.token);
    const refresh = this.store.getRefreshToken(request.token);
    if (refresh && refresh.clientId === client.client_id) this.store.deleteRefreshToken(request.token);
  }

  private issueTokens(clientId: string, scopes: string[], userId: string, resource?: string): OAuthTokens {
    const accessToken = newSecret();
    const refreshToken = newSecret();
    this.store.saveToken(accessToken, {
      clientId,
      scopes,
      userId,
      resource,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    });
    this.store.saveRefreshToken(refreshToken, {
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
