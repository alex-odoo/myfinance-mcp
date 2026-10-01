import { createHash } from "node:crypto";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { Prisma } from "../generated/prisma/client";
import { db, logEvent } from "../db";

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
  grantId?: string;
}

export interface RefreshTokenRecord extends TokenRecord {
  /** First sign-in of the grant; undefined on rows issued before grants existed. */
  grantIssuedAt?: number;
}

/** A new access + refresh pair: written together with the grant it consumes, or not at all. */
export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  access: TokenRecord;
  refresh: RefreshTokenRecord & { grantId: string; grantIssuedAt: number };
}

/**
 * What the tables hold instead of a bearer value. Our secrets are 32 random
 * bytes (base64url, 43 chars), so a plain sha256 is enough: there is nothing
 * to brute-force, and a lookup stays one indexed equality.
 */
export function secretKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

const HASHED_KEY = /^[0-9a-f]{64}$/;

/** Clients without a live code or token are dropped this long after registration. */
const IDLE_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const tokenRow = (token: string, r: TokenRecord) => ({
  token: secretKey(token),
  clientId: r.clientId,
  scopes: r.scopes,
  userId: r.userId,
  resource: r.resource,
  expiresAt: new Date(r.expiresAt),
  grantId: r.grantId,
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
        code: secretKey(code),
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
    const row = await db.oauthCode.findUnique({ where: { code: secretKey(code) } });
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
        where: { code: secretKey(code), clientId, expiresAt: { gt: new Date() } },
      });
      if (count !== 1) throw new InvalidGrantError("Invalid authorization code");
      await insertTokens(tx, tokens);
    });
  }

  /**
   * Refresh rotation. The presented token is marked rotated in the commit
   * that writes its successor, so a failed write leaves it usable. A rotated
   * token keeps working for `graceMs` (a client that refreshes in parallel
   * gets a pair on every request instead of losing its connector to the
   * request that came second). Presented after that, it is a replay: someone
   * else holds a copy, so the whole grant is revoked, the successor the
   * thief may be using included (RFC 9700 4.14.2).
   */
  async rotateRefreshToken(oldToken: string, clientId: string, tokens: IssuedTokens, graceMs: number): Promise<void> {
    const key = secretKey(oldToken);
    const outcome = await db.$transaction(async (tx) => {
      const now = new Date();
      const live = { token: key, clientId, expiresAt: { gt: now } };
      // First use: claim the rotation. Of two concurrent first uses one
      // UPDATE matches; the other waits on the row lock, re-checks, finds
      // rotatedAt set and falls through to the grace rule below. The grant
      // id is the row's own, except on a row from before grants: it joins
      // the grant its successor starts, so a replay of it reaches that one.
      const { count: claimed } = await tx.oauthRefreshToken.updateMany({
        where: { ...live, rotatedAt: null },
        data: { rotatedAt: now, grantId: tokens.refresh.grantId },
      });
      if (claimed !== 1) {
        const row = await tx.oauthRefreshToken.findFirst({ where: live, select: { rotatedAt: true, grantId: true } });
        if (!row?.rotatedAt) throw new InvalidGrantError("Invalid refresh token");
        if (now.getTime() - row.rotatedAt.getTime() > graceMs) return { replayed: true, grantId: row.grantId };
      }
      await insertTokens(tx, tokens);
      return { replayed: false, grantId: null };
    });
    if (outcome.replayed) {
      await this.revokeGrant(outcome.grantId ?? undefined, oldToken);
      logEvent("oauth_refresh_replay", undefined, { client_id: clientId.slice(0, 64) });
      console.error(`[oauth] refresh token replayed after rotation, grant revoked (client ${clientId.slice(0, 64)})`);
      throw new InvalidGrantError("Refresh token was already used. Sign in again from your AI client.");
    }
  }

  /** Every token of one sign-in. A row from before grants existed goes alone. */
  async revokeGrant(grantId: string | undefined, refreshToken: string): Promise<void> {
    await db.$transaction([
      db.oauthRefreshToken.deleteMany({ where: grantId ? { grantId } : { token: secretKey(refreshToken) } }),
      ...(grantId ? [db.oauthAccessToken.deleteMany({ where: { grantId } })] : []),
    ]);
  }

  async getToken(token: string): Promise<TokenRecord | undefined> {
    const row = await db.oauthAccessToken.findUnique({ where: { token: secretKey(token) } });
    if (!row || row.expiresAt.getTime() < Date.now()) return undefined;
    return {
      clientId: row.clientId,
      scopes: row.scopes,
      userId: row.userId,
      resource: row.resource ?? undefined,
      expiresAt: row.expiresAt.getTime(),
      grantId: row.grantId ?? undefined,
    };
  }

  async deleteToken(token: string): Promise<void> {
    await db.oauthAccessToken.deleteMany({ where: { token: secretKey(token) } });
  }

  /** A live refresh token, rotated or not (the rotation decides what a rotated one gets). */
  async getRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    const row = await db.oauthRefreshToken.findUnique({ where: { token: secretKey(token) } });
    if (!row || row.expiresAt.getTime() < Date.now()) return undefined;
    return {
      clientId: row.clientId,
      scopes: row.scopes,
      userId: row.userId,
      resource: row.resource ?? undefined,
      expiresAt: row.expiresAt.getTime(),
      grantId: row.grantId ?? undefined,
      grantIssuedAt: row.grantIssuedAt?.getTime(),
    };
  }

  /** Called opportunistically; keeps the token tables from growing forever. */
  async pruneExpired(): Promise<void> {
    const now = new Date();
    await db.oauthCode.deleteMany({ where: { expiresAt: { lt: now } } });
    await db.oauthAccessToken.deleteMany({ where: { expiresAt: { lt: now } } });
    await db.oauthRefreshToken.deleteMany({ where: { expiresAt: { lt: now } } });
  }

  /**
   * Registration is anonymous and its rows were permanent: scanners,
   * inspectors and abandoned connects pile up. A client without a live code
   * or token can do nothing until it signs in again, and a new sign-in from
   * claude.ai or ChatGPT registers a new client anyway (one row per
   * reconnect in prod); MCP SDK clients re-register on invalid_client. So
   * such a client is dropped once it is older than IDLE_CLIENT_TTL_MS. A
   * client with a live refresh token is never touched: that is the one
   * claude.ai keeps for good.
   */
  async pruneIdleClients(signingIn: ReadonlySet<string> = new Set()): Promise<number> {
    const now = new Date();
    const old = await db.oauthClient.findMany({
      where: { createdAt: { lt: new Date(now.getTime() - IDLE_CLIENT_TTL_MS) } },
      select: { clientId: true },
    });
    let dropped = 0;
    // Chunks keep every IN list far below the bind-parameter limit.
    for (let i = 0; i < old.length; i += 500) {
      const chunk = old.slice(i, i + 500).map((c) => c.clientId);
      const live = { where: { clientId: { in: chunk }, expiresAt: { gt: now } }, select: { clientId: true } };
      const [codes, access, refresh] = await Promise.all([
        db.oauthCode.findMany(live),
        db.oauthAccessToken.findMany(live),
        db.oauthRefreshToken.findMany(live),
      ]);
      const inUse = new Set([...codes, ...access, ...refresh].map((r) => r.clientId));
      // A sign-in in progress holds no code yet, only a pending request.
      const idle = chunk.filter((id) => !inUse.has(id) && !signingIn.has(id));
      if (idle.length) dropped += (await db.oauthClient.deleteMany({ where: { clientId: { in: idle } } })).count;
    }
    return dropped;
  }

  /**
   * Rows written before 2026-10-01 hold the bearer value itself. Re-keys them
   * to its hash; a refresh token also becomes its own grant, so its absolute
   * lifetime starts now. Production boot only: the e2e gate runs new code
   * against the production database while the old container still serves,
   * and re-keying then would sign every connected user out mid-deploy.
   */
  async hashLegacySecrets(): Promise<number> {
    const now = new Date();
    let rekeyed = 0;
    const codes = (await db.oauthCode.findMany({ select: { code: true } })).map((r) => r.code);
    for (const code of codes.filter((k) => !HASHED_KEY.test(k))) {
      rekeyed += (await db.oauthCode.updateMany({ where: { code }, data: { code: secretKey(code) } })).count;
    }
    // Legacy rows carry no link between an access token and its refresh
    // token; the client + user pair is the sign-in they came from, so an
    // access token joins the grant of the one refresh token of its pair.
    const grantOfPair = new Map<string, string | null>();
    const legacyRefresh = await db.oauthRefreshToken.findMany({ select: { token: true, clientId: true, userId: true } });
    for (const r of legacyRefresh.filter((r) => !HASHED_KEY.test(r.token))) {
      const grantId = crypto.randomUUID();
      const pair = `${r.clientId}|${r.userId}`;
      grantOfPair.set(pair, grantOfPair.has(pair) ? null : grantId); // two refresh tokens: ambiguous
      rekeyed += (
        await db.oauthRefreshToken.updateMany({
          where: { token: r.token },
          data: { token: secretKey(r.token), grantId, grantIssuedAt: now },
        })
      ).count;
    }
    const legacyAccess = await db.oauthAccessToken.findMany({ select: { token: true, clientId: true, userId: true } });
    for (const a of legacyAccess.filter((a) => !HASHED_KEY.test(a.token))) {
      rekeyed += (
        await db.oauthAccessToken.updateMany({
          where: { token: a.token },
          data: { token: secretKey(a.token), grantId: grantOfPair.get(`${a.clientId}|${a.userId}`) ?? null },
        })
      ).count;
    }
    return rekeyed;
  }
}

async function insertTokens(tx: Prisma.TransactionClient, t: IssuedTokens): Promise<void> {
  await tx.oauthAccessToken.create({ data: tokenRow(t.accessToken, t.access) });
  await tx.oauthRefreshToken.create({
    data: { ...tokenRow(t.refreshToken, t.refresh), grantIssuedAt: new Date(t.refresh.grantIssuedAt) },
  });
}
