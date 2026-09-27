import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
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

/**
 * Supabase-backed OAuth state (was a JSON file in Gate A). The container is
 * stateless now: restarts and redeploys keep every session alive.
 */
export class OAuthStore {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const row = await db.oauthClient.findUnique({ where: { clientId } });
    if (!row) return undefined;
    const client = row.data as unknown as OAuthClientInformationFull;
    // Clients registered before secrets stopped expiring still carry a 30-day
    // client_secret_expires_at; ignore it so their connectors keep refreshing.
    return client.client_secret ? { ...client, client_secret_expires_at: 0 } : client;
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

  async deleteCode(code: string): Promise<void> {
    await db.oauthCode.deleteMany({ where: { code } });
  }

  async saveToken(token: string, r: TokenRecord): Promise<void> {
    await db.oauthAccessToken.create({
      data: {
        token,
        clientId: r.clientId,
        scopes: r.scopes,
        userId: r.userId,
        resource: r.resource,
        expiresAt: new Date(r.expiresAt),
      },
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

  async saveRefreshToken(token: string, r: TokenRecord): Promise<void> {
    await db.oauthRefreshToken.create({
      data: {
        token,
        clientId: r.clientId,
        scopes: r.scopes,
        userId: r.userId,
        resource: r.resource,
        expiresAt: new Date(r.expiresAt),
      },
    });
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
