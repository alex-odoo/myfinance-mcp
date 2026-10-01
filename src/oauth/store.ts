import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { Prisma } from "../generated/prisma/client";
import { db } from "../db";

export interface AuthCodeRecord {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  userId: string;
  expiresAt: number;
}

export interface TokenRecord {
  clientId: string;
  scopes: string[];
  userId: string;
  resource?: string;
  expiresAt: number;
}

/** A new access + refresh pair: written together with the grant it consumes, or not at all. */
export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  access: TokenRecord;
  refresh: TokenRecord;
}

const tokenRow = (token: string, r: TokenRecord) => ({
  token,
  clientId: r.clientId,
  scopes: r.scopes,
  userId: r.userId,
  resource: r.resource,
  expiresAt: new Date(r.expiresAt),
});

/**
 * Until 2026-09-27 the SDK stamped every DCR secret with a 30-day expiry;
 * claude.ai never re-registers, so those connectors died on day 31. A row
 * carrying exactly that default stamp is treated as never expiring. Any other
 * stored expiry is enforced by the SDK, which is how a leaked client is cut
 * off: set a past client_secret_expires_at on its row.
 */
const SDK_DEFAULT_SECRET_TTL_S = 30 * 24 * 60 * 60;

function hasSdkDefaultSecretStamp(client: OAuthClientInformationFull): boolean {
  const expiresAt = client.client_secret_expires_at ?? 0;
  if (!client.client_secret || expiresAt <= 0) return false;
  // The provider re-stamps client_id_issued_at right after the SDK computed
  // the expiry, so allow a few seconds of drift (all prod rows: exactly 0).
  return Math.abs(expiresAt - (client.client_id_issued_at ?? 0) - SDK_DEFAULT_SECRET_TTL_S) <= 10;
}

/**
 * Supabase-backed OAuth state (was a JSON file in Gate A). The container is
 * stateless now: restarts and redeploys keep every session alive.
 */
export class OAuthStore {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const row = await db.oauthClient.findUnique({ where: { clientId } });
    if (!row) return undefined;
    const client = row.data as unknown as OAuthClientInformationFull;
    return hasSdkDefaultSecretStamp(client) ? { ...client, client_secret_expires_at: 0 } : client;
  }

  async saveClient(client: OAuthClientInformationFull): Promise<void> {
    await db.oauthClient.upsert({
      where: { clientId: client.client_id },
      update: { data: client as object },
      create: { clientId: client.client_id, data: client as object },
    });
  }

  async saveCode(code: string, r: AuthCodeRecord): Promise<void> {
    await db.oauthCode.create({
      data: {
        code,
        clientId: r.clientId,
        codeChallenge: r.codeChallenge,
        redirectUri: r.redirectUri,
        scopes: r.scopes,
        resource: r.resource,
        userId: r.userId,
        expiresAt: new Date(r.expiresAt),
      },
    });
  }

  async getCode(code: string): Promise<AuthCodeRecord | undefined> {
    const row = await db.oauthCode.findUnique({ where: { code } });
    if (!row || row.expiresAt.getTime() < Date.now()) return undefined;
    return {
      clientId: row.clientId,
      codeChallenge: row.codeChallenge,
      redirectUri: row.redirectUri,
      scopes: row.scopes,
      resource: row.resource ?? undefined,
      userId: row.userId,
      expiresAt: row.expiresAt.getTime(),
    };
  }

  /**
   * Single use, enforced by the database: the code row is deleted and the new
   * pair written in one transaction. Of two concurrent redemptions only one
   * DELETE matches the row (the other waits on its lock and then finds it
   * gone), and a failed insert rolls the code back so the client can retry.
   */
  async redeemCode(code: string, clientId: string, tokens: IssuedTokens): Promise<void> {
    await db.$transaction(async (tx) => {
      const { count } = await tx.oauthCode.deleteMany({
        where: { code, clientId, expiresAt: { gt: new Date() } },
      });
      if (count !== 1) throw new InvalidGrantError("Invalid authorization code");
      await insertTokens(tx, tokens);
    });
  }

  /**
   * Refresh rotation, same rule: the presented token is retired only in the
   * commit that writes its successor, so a failed write leaves it usable.
   * Retired = its expiry cut to `graceMs` from now, not deleted: a client that
   * refreshes in parallel (the old code tolerated it) gets a pair on every
   * request instead of invalid_grant on all but one, which drops a connector.
   * The cut applies once; a reuse inside the window never extends it.
   */
  async rotateRefreshToken(oldToken: string, clientId: string, tokens: IssuedTokens, graceMs: number): Promise<void> {
    await db.$transaction(async (tx) => {
      const now = new Date();
      const graceEnd = new Date(now.getTime() + graceMs);
      const { count: retired } = await tx.oauthRefreshToken.updateMany({
        where: { token: oldToken, clientId, expiresAt: { gt: graceEnd } },
        data: { expiresAt: graceEnd },
      });
      if (retired !== 1) {
        const stillValid = await tx.oauthRefreshToken.count({
          where: { token: oldToken, clientId, expiresAt: { gt: now } },
        });
        if (stillValid !== 1) throw new InvalidGrantError("Invalid refresh token");
      }
      await insertTokens(tx, tokens);
    });
  }

  async getToken(token: string): Promise<TokenRecord | undefined> {
    const row = await db.oauthAccessToken.findUnique({ where: { token } });
    if (!row || row.expiresAt.getTime() < Date.now()) return undefined;
    return {
      clientId: row.clientId,
      scopes: row.scopes,
      userId: row.userId,
      resource: row.resource ?? undefined,
      expiresAt: row.expiresAt.getTime(),
    };
  }

  async deleteToken(token: string): Promise<void> {
    await db.oauthAccessToken.deleteMany({ where: { token } });
  }

  async getRefreshToken(token: string): Promise<TokenRecord | undefined> {
    const row = await db.oauthRefreshToken.findUnique({ where: { token } });
    if (!row || row.expiresAt.getTime() < Date.now()) return undefined;
    return {
      clientId: row.clientId,
      scopes: row.scopes,
      userId: row.userId,
      resource: row.resource ?? undefined,
      expiresAt: row.expiresAt.getTime(),
    };
  }

  async deleteRefreshToken(token: string): Promise<void> {
    await db.oauthRefreshToken.deleteMany({ where: { token } });
  }

  /** Called opportunistically; keeps the token tables from growing forever. */
  async pruneExpired(): Promise<void> {
    const now = new Date();
    await db.oauthCode.deleteMany({ where: { expiresAt: { lt: now } } });
    await db.oauthAccessToken.deleteMany({ where: { expiresAt: { lt: now } } });
    await db.oauthRefreshToken.deleteMany({ where: { expiresAt: { lt: now } } });
  }
}

async function insertTokens(tx: Prisma.TransactionClient, t: IssuedTokens): Promise<void> {
  await tx.oauthAccessToken.create({ data: tokenRow(t.accessToken, t.access) });
  await tx.oauthRefreshToken.create({ data: tokenRow(t.refreshToken, t.refresh) });
}
