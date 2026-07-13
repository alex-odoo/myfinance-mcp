import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface AuthCodeRecord {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  userId: string;
  expiresAt: number;
}

export interface AccessTokenRecord {
  clientId: string;
  scopes: string[];
  userId: string;
  resource?: string;
  expiresAt: number;
}

export interface RefreshTokenRecord {
  clientId: string;
  scopes: string[];
  userId: string;
  resource?: string;
  expiresAt: number;
}

interface StoreData {
  clients: Record<string, OAuthClientInformationFull>;
  codes: Record<string, AuthCodeRecord>;
  tokens: Record<string, AccessTokenRecord>;
  refreshTokens: Record<string, RefreshTokenRecord>;
}

const EMPTY: StoreData = { clients: {}, codes: {}, tokens: {}, refreshTokens: {} };

/**
 * JSON-file-backed OAuth state. Gate A scope: single box, low volume;
 * moves to Supabase together with user accounts in M1.
 */
export class OAuthStore {
  private data: StoreData;
  private readonly file: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, "oauth.json");
    this.data = existsSync(this.file)
      ? { ...EMPTY, ...(JSON.parse(readFileSync(this.file, "utf8")) as StoreData) }
      : structuredClone(EMPTY);
    this.prune();
  }

  private persist(): void {
    this.prune();
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of Object.entries(this.data.codes)) if (v.expiresAt < now) delete this.data.codes[k];
    for (const [k, v] of Object.entries(this.data.tokens)) if (v.expiresAt < now) delete this.data.tokens[k];
    for (const [k, v] of Object.entries(this.data.refreshTokens)) if (v.expiresAt < now) delete this.data.refreshTokens[k];
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.data.clients[clientId];
  }

  saveClient(client: OAuthClientInformationFull): void {
    this.data.clients[client.client_id] = client;
    this.persist();
  }

  saveCode(code: string, record: AuthCodeRecord): void {
    this.data.codes[code] = record;
    this.persist();
  }

  getCode(code: string): AuthCodeRecord | undefined {
    const rec = this.data.codes[code];
    return rec && rec.expiresAt >= Date.now() ? rec : undefined;
  }

  deleteCode(code: string): void {
    delete this.data.codes[code];
    this.persist();
  }

  saveToken(token: string, record: AccessTokenRecord): void {
    this.data.tokens[token] = record;
    this.persist();
  }

  getToken(token: string): AccessTokenRecord | undefined {
    const rec = this.data.tokens[token];
    return rec && rec.expiresAt >= Date.now() ? rec : undefined;
  }

  deleteToken(token: string): void {
    delete this.data.tokens[token];
    this.persist();
  }

  saveRefreshToken(token: string, record: RefreshTokenRecord): void {
    this.data.refreshTokens[token] = record;
    this.persist();
  }

  getRefreshToken(token: string): RefreshTokenRecord | undefined {
    const rec = this.data.refreshTokens[token];
    return rec && rec.expiresAt >= Date.now() ? rec : undefined;
  }

  deleteRefreshToken(token: string): void {
    delete this.data.refreshTokens[token];
    this.persist();
  }
}
