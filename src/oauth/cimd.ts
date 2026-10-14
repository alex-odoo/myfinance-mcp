import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidClientError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { config } from "../config";
import { db } from "../db";
import { pruneMap } from "../httpUtil";

/**
 * OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-
 * document, MCP 2025-11-25). A client_id that is an https URL names a JSON
 * document the client publishes about itself; claude.ai's "Use Claude's
 * published identity" is https://claude.ai/oauth/mcp-oauth-client-metadata.
 * Nothing is registered: the document is fetched when the client shows up,
 * cached, and checked.
 *
 * The URL comes from anyone, so the fetch is fenced: https on the default
 * port, a host name (no IP literal) whose every address is public, no
 * redirects, 5 seconds, 16 KB. The resolver is asked again by fetch, so a
 * host that flips its DNS between the two answers is not stopped here; the
 * https-on-443 rule leaves it nothing on our network to reach that is not
 * public anyway. A document counts only if its own client_id is the URL, so
 * nothing fetched from anywhere else is ever shown or used.
 *
 * A client that signed someone in keeps a copy in oauth_clients (keyed by the
 * URL): when its host is briefly down, refreshes go on from that copy instead
 * of dropping the connector. Claude's two documents are also built in: the
 * Cloudflare in front of claude.ai answers some datacenter addresses with a
 * 403 challenge (anthropics/claude-ai-mcp#650), and a new Claude user must
 * not be locked out by that.
 */

const MIN_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
/** How old a kept copy may be and still stand in for an unreachable document. */
const STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** A refusal (bad document, 404) is remembered this long; an outage, briefly. */
const REFUSAL_TTL_MS = 60 * 1000;
const OUTAGE_TTL_MS = 10 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_DOCUMENT_BYTES = 16 * 1024;
const MAX_URL_LENGTH = 512;
const MAX_CACHED = 1000;
const MAX_REDIRECT_URIS = 10;
const MAX_FIELD_LENGTH = 2048;
const MAX_CLIENT_NAME = 100;
// /authorize is anonymous: without a cap, a stream of made-up client_ids
// would have this server fetch whatever URLs it is handed.
const FETCHES_PER_MINUTE = 30;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Schemes a redirect may never use. Other custom schemes are a native app's
// own (RFC 8252 7.1, cursor:// and the like).
const FORBIDDEN_REDIRECT_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ftp:", "ws:", "wss:"]);

/**
 * Claude's published documents as served on 2026-10-14, used only when the
 * live one cannot be read (an outage or a challenge, never a refusal). They
 * pass the same checks as a fetched document.
 */
export const CIMD_BUILT_IN: Readonly<Record<string, object>> = {
  "https://claude.ai/oauth/mcp-oauth-client-metadata": {
    client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
    client_name: "Claude",
    client_uri: "https://claude.ai",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  },
  "https://claude.ai/oauth/claude-code-client-metadata": {
    client_id: "https://claude.ai/oauth/claude-code-client-metadata",
    client_name: "Claude Code",
    client_uri: "https://claude.ai",
    redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  },
};

interface Failure {
  /** The document is wrong or gone (InvalidClient); otherwise its host could not be reached (ServerError). */
  refused: boolean;
  message: string;
  until: number;
}

interface CacheEntry {
  client?: OAuthClientInformationFull;
  fetchedAt?: number;
  freshUntil: number;
  failure?: Failure;
  /** For pruneMap: the entry is worth keeping until its last use runs out. */
  expiresAt: number;
}

class FetchFailure extends Error {
  constructor(
    readonly refused: boolean,
    message: string
  ) {
    super(message);
  }
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<OAuthClientInformationFull>>();
let budget = { minute: 0, used: 0 };

/** A client_id this module answers for: an https URL (http on loopback in a local test setup). */
export function isCimdClientId(clientId: string): boolean {
  return clientId.startsWith("https://") || (config.cimdAllowLoopback && clientId.startsWith("http://"));
}

/** The host that publishes a client's document, for messages and the sign-in page. */
export function cimdHost(clientId: string): string {
  try {
    return new URL(clientId).host;
  } catch {
    return clientId.slice(0, 64);
  }
}

/** Why a client_id URL cannot name a document, or undefined. Exported for e2e. */
export function cimdUrlProblem(clientId: string): string | undefined {
  if (clientId.length > MAX_URL_LENGTH) return "is too long";
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return "is not a URL";
  }
  // Compared as a plain string with the document's own client_id, so only
  // the canonical spelling is accepted: no parser can read it two ways.
  if (url.href !== clientId) return "is not in canonical form";
  const testSetup = config.cimdAllowLoopback && url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !testSetup) return "must use https";
  if (url.username || url.password) return "must not carry credentials";
  if (url.hash) return "must not have a fragment";
  if (url.pathname === "/") return "must have a path";
  if (testSetup) return undefined;
  if (url.port) return "must use the default https port";
  if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) return "must name a host, not an IP address";
  if (!url.hostname.includes(".")) return "must name a public host";
  return undefined;
}

/** Public unicast IPv4: none of the private, loopback, link-local, shared, test or multicast blocks. */
function ipv4Public(ip: string): boolean {
  const o = ip.split(".").map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (o.length !== 4 || o.some((n) => !(n >= 0 && n <= 255))) return false;
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // shared address space (CGNAT)
  if (a === 169 && b === 254) return false; // link-local, cloud metadata services
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6Groups(ip: string): number[] | undefined {
  let s = ip.toLowerCase().split("%")[0]!;
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const o = dotted[1]!.split(".").map(Number);
    if (o.some((n) => !(n >= 0 && n <= 255))) return undefined;
    s = `${s.slice(0, -dotted[1]!.length)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const parts = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (parts.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return parts.map((g) => parseInt(g, 16));
}

const embeddedV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** Global unicast IPv6 (2000::/3) that does not wrap a non-public IPv4 address. */
function ipv6Public(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return false;
  // IPv4-mapped (::ffff:a.b.c.d) and the old IPv4-compatible form
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return g[5] === 0xffff || g[6]! > 0 ? ipv4Public(embeddedV4(g[6]!, g[7]!)) : false;
  }
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo: the IPv4 inside is obfuscated
  if (g[0] === 0x2002) return ipv4Public(embeddedV4(g[1]!, g[2]!)); // 6to4
  return true;
}

function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? ipv4Public(address) : family === 6 ? ipv6Public(address) : false;
}

/** Exported for e2e: the address check, without a resolver. */
export const cimdPublicAddress = publicAddress;

async function assertPublicHost(hostname: string): Promise<void> {
  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new FetchFailure(false, `${hostname} does not resolve`);
  }
  if (!addresses.length) throw new FetchFailure(false, `${hostname} does not resolve`);
  if (addresses.some((a) => !publicAddress(a.address))) {
    throw new FetchFailure(true, `${hostname} resolves to an address that is not public`);
  }
}

function redirectAllowed(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname);
  return !FORBIDDEN_REDIRECT_SCHEMES.has(url.protocol);
}

/** The client a valid document describes; anything else is refused with what is wrong. Exported for e2e. */
export function clientFromDocument(clientId: string, doc: unknown): OAuthClientInformationFull {
  const refuse = (why: string): never => {
    throw new FetchFailure(true, `the client metadata document ${why}`);
  };
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return refuse("is not a JSON object");
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId) return refuse("names a different client_id");
  // Shared secrets have no place in a public document (draft section 4.1).
  if ("client_secret" in d || "client_secret_expires_at" in d) return refuse("carries a client secret");
  const method = d.token_endpoint_auth_method ?? "none";
  if (method !== "none") {
    return refuse(`asks for token_endpoint_auth_method ${String(method).slice(0, 40)}, and this server takes public clients only ("none")`);
  }
  const redirects = d.redirect_uris;
  if (!Array.isArray(redirects) || !redirects.length || redirects.length > MAX_REDIRECT_URIS) {
    return refuse(`needs 1 to ${MAX_REDIRECT_URIS} redirect_uris`);
  }
  for (const uri of redirects) {
    if (typeof uri !== "string" || uri.length > MAX_FIELD_LENGTH || !redirectAllowed(uri)) return refuse("has a redirect_uri this server cannot use");
  }
  if (d.grant_types !== undefined && !(Array.isArray(d.grant_types) && d.grant_types.includes("authorization_code"))) {
    return refuse("does not allow the authorization_code grant");
  }
  if (d.response_types !== undefined && !(Array.isArray(d.response_types) && d.response_types.includes("code"))) {
    return refuse("does not allow response_type code");
  }
  const name = typeof d.client_name === "string" ? d.client_name.trim().slice(0, MAX_CLIENT_NAME) : "";
  const clientUri =
    typeof d.client_uri === "string" && d.client_uri.length <= MAX_FIELD_LENGTH && d.client_uri.startsWith("https://")
      ? d.client_uri
      : undefined;
  return {
    client_id: clientId,
    client_name: name || cimdHost(clientId),
    ...(clientUri ? { client_uri: clientUri } : {}),
    redirect_uris: redirects as string[],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/** Cache-Control max-age within [5 minutes, 24 hours]; an hour when the host says nothing. */
function freshFor(cacheControl: string | null): number {
  if (!cacheControl) return DEFAULT_TTL_MS;
  if (/no-store|no-cache/i.test(cacheControl)) return MIN_TTL_MS;
  const maxAge = cacheControl.match(/max-age=(\d+)/i);
  if (!maxAge) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Number(maxAge[1]) * 1000));
}

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_DOCUMENT_BYTES) throw new FetchFailure(true, "the client metadata document is too large");
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_DOCUMENT_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new FetchFailure(true, "the client metadata document is too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function fetchDocument(clientId: string): Promise<{ client: OAuthClientInformationFull; ttlMs: number }> {
  const url = new URL(clientId);
  const host = url.host;
  const minute = Math.floor(Date.now() / 60_000);
  if (budget.minute !== minute) budget = { minute, used: 0 };
  if (++budget.used > FETCHES_PER_MINUTE) throw new FetchFailure(false, "too many client lookups right now, try again in a minute");
  if (!(config.cimdAllowLoopback && LOOPBACK.has(url.hostname))) await assertPublicHost(url.hostname);
  let res: Response;
  try {
    res = await fetch(clientId, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch {
    throw new FetchFailure(false, `${host} did not answer`);
  }
  if (res.status === 404 || res.status === 410) throw new FetchFailure(true, `${host} publishes no client metadata at this URL`);
  if (res.status >= 300 && res.status < 400) throw new FetchFailure(true, `${host} redirects the client metadata document, which is not followed`);
  if (res.status !== 200) throw new FetchFailure(false, `${host} answered ${res.status}`);
  let text: string;
  try {
    text = await readCapped(res);
  } catch (e) {
    if (e instanceof FetchFailure) throw e;
    throw new FetchFailure(false, `${host} did not answer`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new FetchFailure(true, "the client metadata document is not JSON");
  }
  return { client: clientFromDocument(clientId, doc), ttlMs: freshFor(res.headers.get("cache-control")) };
}

/** Kept copy: the validated client plus when its document was read. */
type KeptCopy = OAuthClientInformationFull & { cimd_fetched_at: number };

async function keptCopy(clientId: string): Promise<{ client: OAuthClientInformationFull; fetchedAt: number } | undefined> {
  try {
    const row = await db.oauthClient.findUnique({ where: { clientId } });
    const data = row?.data as KeptCopy | undefined;
    if (!data || typeof data.cimd_fetched_at !== "number") return undefined;
    const { cimd_fetched_at: fetchedAt, ...stored } = data;
    // Re-checked like a fresh document: a row is never trusted past the rules.
    return { client: clientFromDocument(clientId, stored), fetchedAt };
  } catch {
    return undefined;
  }
}

function remember(clientId: string, entry: Omit<CacheEntry, "expiresAt">): void {
  const lastUse = Math.max(entry.freshUntil, entry.failure?.until ?? 0, (entry.fetchedAt ?? 0) + STALE_MAX_MS);
  cache.delete(clientId); // re-insert at the end: pruneMap drops the oldest first
  pruneMap(cache, MAX_CACHED);
  cache.set(clientId, { ...entry, expiresAt: lastUse });
}

/** One fetch per URL at a time; the outcome lands in the cache either way. */
function fetchOnce(clientId: string): Promise<OAuthClientInformationFull> {
  const running = inFlight.get(clientId);
  if (running) return running;
  const attempt = (async () => {
    const previous = cache.get(clientId);
    try {
      const { client, ttlMs } = await fetchDocument(clientId);
      const fetchedAt = Date.now();
      remember(clientId, { client, fetchedAt, freshUntil: fetchedAt + ttlMs });
      // Refresh the kept copy, if this client has one (it signed someone in).
      void db.oauthClient
        .updateMany({ where: { clientId }, data: { data: { ...client, cimd_fetched_at: fetchedAt } as object } })
        .catch(() => undefined);
      return client;
    } catch (e) {
      const failure: Failure =
        e instanceof FetchFailure
          ? { refused: e.refused, message: e.message, until: 0 }
          : { refused: false, message: `${cimdHost(clientId)} could not be read`, until: 0 };
      failure.until = Date.now() + (failure.refused ? REFUSAL_TTL_MS : OUTAGE_TTL_MS);
      // A refusal drops the copy in memory; an outage keeps it for the stale path.
      remember(clientId, {
        client: failure.refused ? undefined : previous?.client,
        fetchedAt: failure.refused ? undefined : previous?.fetchedAt,
        freshUntil: 0,
        failure,
      });
      throw e;
    }
  })();
  inFlight.set(clientId, attempt);
  void attempt.catch(() => undefined).finally(() => inFlight.delete(clientId));
  return attempt;
}

/**
 * The client behind a URL client_id. Throws InvalidClientError when the
 * document is wrong or gone, ServerError when its host cannot be reached and
 * no recent copy stands in.
 */
export async function cimdClient(clientId: string): Promise<OAuthClientInformationFull> {
  const problem = cimdUrlProblem(clientId);
  if (problem) throw new InvalidClientError(`client_id ${problem}`);
  const now = Date.now();
  const entry = cache.get(clientId);
  if (entry?.client && entry.freshUntil > now) return entry.client;
  let failure = entry?.failure && entry.failure.until > now ? entry.failure : undefined;
  if (!failure) {
    try {
      return await fetchOnce(clientId);
    } catch (e) {
      failure = cache.get(clientId)?.failure ?? { refused: false, message: e instanceof Error ? e.message : "lookup failed", until: 0 };
    }
  }
  if (failure.refused) throw new InvalidClientError(failure.message);
  const held = cache.get(clientId);
  if (held?.client && held.fetchedAt && now - held.fetchedAt < STALE_MAX_MS) return held.client;
  const kept = await keptCopy(clientId);
  if (kept && now - kept.fetchedAt < STALE_MAX_MS) {
    console.error(`[oauth] client metadata at ${cimdHost(clientId)} unreachable (${failure.message}); using the copy from ${new Date(kept.fetchedAt).toISOString()}`);
    return kept.client;
  }
  const builtIn = CIMD_BUILT_IN[clientId];
  if (builtIn) {
    console.error(`[oauth] client metadata at ${cimdHost(clientId)} unreachable (${failure.message}); using the built-in copy`);
    return clientFromDocument(clientId, builtIn);
  }
  throw new ServerError(`Could not read the client metadata document: ${failure.message}`);
}

/**
 * Keeps a copy of a client that just signed someone in (called at the code
 * exchange), so its refreshes survive an outage of its document host.
 */
export async function keepCimdClient(clientId: string): Promise<void> {
  const entry = cache.get(clientId);
  if (!entry?.client || !entry.fetchedAt) return;
  const data = { ...entry.client, cimd_fetched_at: entry.fetchedAt } as object;
  await db.oauthClient.upsert({ where: { clientId }, update: { data }, create: { clientId, data } });
}

/** Test hook: forget every cached document (e2e runs the stale path). */
export function forgetCimdCache(): void {
  cache.clear();
  inFlight.clear();
}
