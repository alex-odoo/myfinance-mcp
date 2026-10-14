import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidClientError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { config } from "../config";
import { db } from "../db";
import { LOOPBACK_HOSTS, pruneMap } from "../httpUtil";
import { MAX_CLIENT_NAME, MAX_FIELD_LENGTH, MAX_LIST_ENTRIES } from "./limits";

/**
 * OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-
 * document, MCP 2025-11-25). A client_id that is an https URL names a JSON
 * document the client publishes about itself. claude.ai ("Use Claude's
 * published identity"), ChatGPT and Codex all switch to this as soon as the
 * metadata says client_id_metadata_document_supported. Nothing is
 * registered: the document is fetched when the client shows up, cached, and
 * checked.
 *
 * The URL comes from anyone, so the fetch is fenced: https on the default
 * port, a host name (no IP literal) whose every address is public, no
 * redirects, 3 seconds for DNS and 5 for the fetch, 16 KB, and a budget of
 * lookups per minute, per host and in all. fetch asks the resolver again, so
 * a host that flips its DNS between the two answers is not stopped here; the
 * https-on-443 rule leaves it nothing on our network that is not public
 * anyway. A document counts only if its own client_id is the URL, so nothing
 * fetched from anywhere else is ever shown or used.
 *
 * When the live document cannot be used, a copy stands in: the last one read
 * (memory), the one kept when the client last signed someone in (database),
 * or a built-in copy of a known client's. This holds for a document that
 * turns bad or disappears too, not only for an unreachable host: a 404 or a
 * challenge page in front of claude.ai for a minute must not end every
 * Claude connector's refresh with invalid_client (the 2026-09-24 outage
 * looked exactly like that). The cost is that a publisher cannot revoke its
 * client here by withdrawing the document while a copy is under 7 days old;
 * a public client holds no secret worth revoking, and its redirect URIs in
 * the copy are its own.
 */

const MIN_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
/** How old a copy may be and still stand in for a document that cannot be used. */
const STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** After a copy stood in, the live document is tried again this much later. */
const RETRY_AFTER_STAND_IN_MS = 60 * 1000;
/** With no copy, a bad document is remembered this long, an unreachable host briefly. */
const BAD_TTL_MS = 60 * 1000;
const UNREACHABLE_TTL_MS = 10 * 1000;
const DNS_TIMEOUT_MS = 3000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_DOCUMENT_BYTES = 16 * 1024;
const MAX_URL_LENGTH = 512;
const MAX_CACHED = 1000;
// /authorize and /token are anonymous: without a budget, a stream of made-up
// client_ids would have this server fetch whatever it is handed. Per host
// first, so one host cannot spend everyone's; a client with a copy keeps
// working while the budget is spent.
const FETCHES_PER_MINUTE = 60;
const FETCHES_PER_HOST_PER_MINUTE = 10;

// Schemes a redirect may never use. Other custom schemes are a native app's
// own (RFC 8252 7.1, cursor:// and the like).
const FORBIDDEN_REDIRECT_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ftp:", "ws:", "wss:"]);

/**
 * Documents of the clients most users come with, as served on 2026-10-14.
 * Used only when the live one cannot be used (the Cloudflare in front of
 * claude.ai and chatgpt.com answers some datacenter addresses with a 403
 * challenge: anthropics/claude-ai-mcp#650). They pass the same checks as a
 * fetched document. ChatGPT and Codex use these stable URLs because this
 * server returns `iss` (RFC 9207); otherwise they send a per-connector URL.
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
  "https://chatgpt.com/oauth/client.json": {
    client_id: "https://chatgpt.com/oauth/client.json",
    client_name: "ChatGPT",
    client_uri: "https://chatgpt.com/",
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  },
  "https://chatgpt.com/oauth/codex/client.json": {
    client_id: "https://chatgpt.com/oauth/codex/client.json",
    client_name: "Codex",
    client_uri: "https://chatgpt.com/codex",
    redirect_uris: ["http://127.0.0.1/callback", "http://localhost/callback"],
    token_endpoint_auth_method: "none",
    token_endpoint_auth_methods_supported: ["none"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  },
};

interface CacheEntry {
  client?: OAuthClientInformationFull;
  /** When the document behind `client` was read; undefined for a built-in copy. */
  fetchedAt?: number;
  /** Until then `client` is served without asking its host. */
  freshUntil: number;
  /** The last attempt's failure, while it is remembered (no copy stood in). */
  failure?: { bad: boolean; message: string; until: number };
  /** For pruneMap: when nothing in the entry is of use any more. */
  expiresAt: number;
}

/** bad: the host answered, and not with a usable document. Otherwise it could not be reached. */
class FetchFailure extends Error {
  constructor(
    readonly bad: boolean,
    message: string
  ) {
    super(message);
  }
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<OAuthClientInformationFull>>();
let budget = { minute: 0, used: 0, perHost: new Map<string, number>() };

/** A client_id this module answers for: an https URL (http on loopback in a local test setup). */
export function isCimdClientId(clientId: string): boolean {
  return clientId.startsWith("https://") || (config.cimdAllowLoopback && clientId.startsWith("http://"));
}

/** The host that publishes a client's document, for messages. */
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
  const testSetup = config.cimdAllowLoopback && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
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

/** Exported for e2e: the address check, without a resolver. */
export function cimdPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? ipv4Public(address) : family === 6 ? ipv6Public(address) : false;
}

async function assertPublicHost(hostname: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FetchFailure(false, `${hostname} did not resolve in time`)), DNS_TIMEOUT_MS);
  });
  let addresses: { address: string }[];
  try {
    addresses = await Promise.race([lookup(hostname, { all: true, verbatim: true }), timeout]);
  } catch (e) {
    throw e instanceof FetchFailure ? e : new FetchFailure(false, `${hostname} does not resolve`);
  } finally {
    clearTimeout(timer);
  }
  if (!addresses.length) throw new FetchFailure(false, `${hostname} does not resolve`);
  if (addresses.some((a) => !cimdPublicAddress(a.address))) {
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
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname);
  return !FORBIDDEN_REDIRECT_SCHEMES.has(url.protocol);
}

/**
 * Whether the document lets the client exchange codes without
 * authenticating ("none"). A plural token_endpoint_auth_methods_supported
 * (ChatGPT's documents) wins over the singular preference: OpenAI asks
 * servers to use any method in the intersection, and "none" is ours. A
 * document that names no method is not a public client (RFC 7591 defaults
 * to client_secret_basic, which a published document cannot hold).
 */
function publicClient(d: Record<string, unknown>): boolean {
  const plural = d.token_endpoint_auth_methods_supported;
  if (Array.isArray(plural)) return plural.includes("none");
  return d.token_endpoint_auth_method === "none";
}

/** The client a valid document describes; anything else is refused with what is wrong. Exported for e2e. */
export function clientFromDocument(clientId: string, doc: unknown): OAuthClientInformationFull {
  const refuse = (why: string): never => {
    throw new FetchFailure(true, `the client metadata document ${why}`);
  };
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return refuse("is not a JSON object");
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId) return refuse("names a different client_id");
  // Shared secrets have no place in a public document.
  if ("client_secret" in d || "client_secret_expires_at" in d) return refuse("carries a client secret");
  if (!publicClient(d)) return refuse('does not offer token_endpoint_auth_method "none", and this server takes public clients only');
  const redirects = d.redirect_uris;
  if (!Array.isArray(redirects) || !redirects.length || redirects.length > MAX_LIST_ENTRIES) {
    return refuse(`needs 1 to ${MAX_LIST_ENTRIES} redirect_uris`);
  }
  for (const uri of redirects) {
    if (typeof uri !== "string" || uri.length > MAX_FIELD_LENGTH || !redirectAllowed(uri)) return refuse("has a redirect_uri this server cannot use");
  }
  const grants = d.grant_types;
  if (grants !== undefined && !(Array.isArray(grants) && grants.includes("authorization_code"))) {
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
    // A document that lists its grants and leaves out refresh_token gets no
    // refresh token. One that lists none gets one: the MCP spec's minimal
    // document has no grant_types, and without refresh its connector would
    // sign out every 24 hours.
    grant_types:
      Array.isArray(grants) && !grants.includes("refresh_token") ? ["authorization_code"] : ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/** Whether a client may hold a refresh token. Only a published document can say no. */
export function refreshAllowed(client: OAuthClientInformationFull): boolean {
  return !isCimdClientId(client.client_id) || (client.grant_types ?? []).includes("refresh_token");
}

/** Cache-Control max-age within [5 minutes, 24 hours]; an hour when the host says nothing. */
function freshFor(cacheControl: string | null): number {
  if (!cacheControl) return DEFAULT_TTL_MS;
  if (/no-store|no-cache/i.test(cacheControl)) return MIN_TTL_MS;
  const maxAge = cacheControl.match(/max-age=(\d+)/i);
  if (!maxAge) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Number(maxAge[1]) * 1000));
}

/** Drops an unread body: a hostile host must not stream into memory until the timeout. */
function discard(res: Response): void {
  void res.body?.cancel().catch(() => undefined);
}

async function readCapped(res: Response): Promise<string> {
  if (Number(res.headers.get("content-length") ?? 0) > MAX_DOCUMENT_BYTES) {
    discard(res);
    throw new FetchFailure(true, "the client metadata document is too large");
  }
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

function spendBudget(host: string): void {
  const minute = Math.floor(Date.now() / 60_000);
  if (budget.minute !== minute) budget = { minute, used: 0, perHost: new Map() };
  const hostUsed = budget.perHost.get(host) ?? 0;
  if (hostUsed >= FETCHES_PER_HOST_PER_MINUTE || budget.used >= FETCHES_PER_MINUTE) {
    throw new FetchFailure(false, "too many client lookups right now, try again in a minute");
  }
  budget.perHost.set(host, hostUsed + 1);
  budget.used++;
}

async function fetchDocument(clientId: string): Promise<{ client: OAuthClientInformationFull; ttlMs: number }> {
  const url = new URL(clientId);
  const host = url.host;
  spendBudget(url.hostname);
  if (!(config.cimdAllowLoopback && LOOPBACK_HOSTS.has(url.hostname))) await assertPublicHost(url.hostname);
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
  if (res.status !== 200) {
    discard(res);
    if (res.status === 404 || res.status === 410) throw new FetchFailure(true, `${host} publishes no client metadata at this URL`);
    if (res.status >= 300 && res.status < 400) throw new FetchFailure(true, `${host} redirects the client metadata document, which is not followed`);
    throw new FetchFailure(false, `${host} answered ${res.status}`);
  }
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

function remember(clientId: string, entry: Omit<CacheEntry, "expiresAt">): void {
  const lastUse = Math.max(entry.freshUntil, entry.failure?.until ?? 0, entry.fetchedAt ? entry.fetchedAt + STALE_MAX_MS : 0);
  cache.delete(clientId); // re-inserted at the end: pruneMap drops the oldest first
  pruneMap(cache, MAX_CACHED);
  cache.set(clientId, { ...entry, expiresAt: lastUse });
}

/**
 * What a kept copy holds: the checked client and when its document was read.
 * The client is stored as a document and re-checked on the way out, so a
 * row is never trusted past the rules.
 */
function keptData(client: OAuthClientInformationFull, fetchedAt: number): object {
  return { cimd_document: client, cimd_fetched_at: fetchedAt };
}

/** The copy kept when this client last signed someone in. */
async function keptCopy(clientId: string): Promise<{ client: OAuthClientInformationFull; fetchedAt: number } | undefined> {
  try {
    const row = await db.oauthClient.findUnique({ where: { clientId } });
    const data = row?.data as { cimd_document?: unknown; cimd_fetched_at?: unknown } | undefined;
    if (!data || typeof data.cimd_fetched_at !== "number") return undefined;
    return { client: clientFromDocument(clientId, data.cimd_document), fetchedAt: data.cimd_fetched_at };
  } catch {
    return undefined;
  }
}

/** The best copy that may stand in for the live document, newest first. */
async function standIn(
  clientId: string,
  now: number
): Promise<{ client: OAuthClientInformationFull; fetchedAt?: number; from: string } | undefined> {
  const held = cache.get(clientId);
  if (held?.client && held.fetchedAt && now - held.fetchedAt < STALE_MAX_MS) {
    return { client: held.client, fetchedAt: held.fetchedAt, from: "the last copy read" };
  }
  const kept = await keptCopy(clientId);
  if (kept && now - kept.fetchedAt < STALE_MAX_MS) return { ...kept, from: "the copy kept at sign-in" };
  const builtIn = CIMD_BUILT_IN[clientId];
  if (builtIn) return { client: clientFromDocument(clientId, builtIn), from: "the built-in copy" };
  return undefined;
}

/** One lookup per URL at a time; its outcome lands in the cache either way. */
function resolve(clientId: string): Promise<OAuthClientInformationFull> {
  const running = inFlight.get(clientId);
  if (running) return running;
  const attempt = (async () => {
    try {
      const { client, ttlMs } = await fetchDocument(clientId);
      const fetchedAt = Date.now();
      remember(clientId, { client, fetchedAt, freshUntil: fetchedAt + ttlMs });
      // Refresh the kept copy, if this client has one (it signed someone in).
      void db.oauthClient.updateMany({ where: { clientId }, data: { data: keptData(client, fetchedAt) } }).catch(() => undefined);
      return client;
    } catch (e) {
      const failure = e instanceof FetchFailure ? e : new FetchFailure(false, `${cimdHost(clientId)} could not be read`);
      const now = Date.now();
      const copy = await standIn(clientId, now);
      if (copy) {
        console.error(`[oauth] client metadata at ${cimdHost(clientId)}: ${failure.message}; using ${copy.from}`);
        remember(clientId, { client: copy.client, fetchedAt: copy.fetchedAt, freshUntil: now + RETRY_AFTER_STAND_IN_MS });
        return copy.client;
      }
      remember(clientId, {
        freshUntil: 0,
        failure: { bad: failure.bad, message: failure.message, until: now + (failure.bad ? BAD_TTL_MS : UNREACHABLE_TTL_MS) },
      });
      throw failure;
    }
  })();
  inFlight.set(clientId, attempt);
  void attempt.catch(() => undefined).finally(() => inFlight.delete(clientId));
  return attempt;
}

const asOAuthError = (failure: { bad: boolean; message: string }) =>
  failure.bad ? new InvalidClientError(failure.message) : new ServerError(`Could not read the client metadata document: ${failure.message}`);

/**
 * The client behind a URL client_id. Throws InvalidClientError when the
 * document is wrong or gone, ServerError when its host cannot be reached;
 * either only when no copy may stand in.
 */
export async function cimdClient(clientId: string): Promise<OAuthClientInformationFull> {
  const problem = cimdUrlProblem(clientId);
  if (problem) throw new InvalidClientError(`client_id ${problem}`);
  const entry = cache.get(clientId);
  const now = Date.now();
  if (entry?.client && entry.freshUntil > now) return entry.client;
  if (entry?.failure && entry.failure.until > now) throw asOAuthError(entry.failure);
  try {
    return await resolve(clientId);
  } catch (e) {
    throw e instanceof FetchFailure ? asOAuthError(e) : e;
  }
}

/**
 * Keeps a copy of a client that just signed someone in (called at the code
 * exchange), so it can stand in when the document cannot be used later.
 */
export async function keepCimdClient(clientId: string): Promise<void> {
  const entry = cache.get(clientId);
  if (!entry?.client || !entry.fetchedAt) return; // a built-in copy needs no keeping
  const data = keptData(entry.client, entry.fetchedAt);
  await db.oauthClient.upsert({ where: { clientId }, update: { data }, create: { clientId, data } });
}

/** Test hook: forget every cached document and the spent budget (e2e runs the stand-in paths). */
export function forgetCimdCache(): void {
  cache.clear();
  inFlight.clear();
  budget = { minute: 0, used: 0, perHost: new Map() };
}
