import { randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";
import { createOAuthMetadata, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config, assertConfig } from "./config";
import { db, logEvent } from "./db";
import { OAuthStore } from "./oauth/store";
import { FinanceOAuthProvider, ISSUER, OFFLINE_ACCESS, SUPPORTED_SCOPES, authorizeRequestProblem, withIssuer } from "./oauth/provider";
import { cimdHost, isCimdClientId } from "./oauth/cimd";
import { escapeHtml, loginPage, maskEmail } from "./oauth/login";
import { bootstrapUser, markSettledCurrencies } from "./users";
import { buildMcpServer, SERVER_NAME, SERVER_VERSION } from "./mcp";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "./categories";
import { instrumentTransport, pruneOldEvents } from "./telemetry";
import { ebCreateSession, ebDeleteSession } from "./enablebanking/client";
import { runAutoSync } from "./autosync";
import { decryptToken, encryptToken } from "./zenmoney/crypto";
import { GOOGLE_CALLBACK_PATH } from "./oauth/google";
import { adminGoogleCallback, adminRouter } from "./admin/router";
import { readCookie, sha256 } from "./httpUtil";
import { bankSyncOffered } from "./bankAccess";
import { digestAvailable, runDigests, unsubscribe, validUnsubscribe } from "./digest";
import { runRecurring } from "./recurring";

assertConfig();

// Bun exits on an unhandled rejection: one fire-and-forget DB write hitting a
// pooler blip would take the server down for everyone. Log it and keep
// serving. Message only: a stack can carry row data (blind-logs rule). A
// failed boot (top-level await) still exits.
process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandled rejection:", reason instanceof Error ? reason.message : String(reason));
});

// Idempotent boot: category dictionary + the single M1 user.
await db.category.createMany({
  data: [
    ...EXPENSE_CATEGORIES.map((key) => ({ key, kind: "expense" as const })),
    ...INCOME_CATEGORIES.filter((k) => !(EXPENSE_CATEGORIES as readonly string[]).includes(k)).map((key) => ({
      key,
      kind: "income" as const,
    })),
  ],
  skipDuplicates: true,
});
await bootstrapUser();
const settled = await markSettledCurrencies();
if (settled) console.log(`[users] marked ${settled} account(s) as having chosen their base currency`);
await pruneOldEvents();
setInterval(() => void pruneOldEvents(), 24 * 60 * 60 * 1000);

const store = new OAuthStore();
const provider = new FinanceOAuthProvider(store);
// Production only: see hashLegacySecrets (the e2e gate shares this database).
if (process.env.NODE_ENV === "production") {
  const rekeyed = await store.hashLegacySecrets();
  if (rekeyed) console.log(`[oauth] re-keyed ${rekeyed} stored code(s)/token(s) to their hash`);
}
const pruneOAuth = async () => {
  await store.pruneExpired();
  const dropped = await store.pruneIdleClients(() => provider.pendingClientIds());
  if (dropped) console.log(`[oauth] dropped ${dropped} idle client registration(s)`);
};
await pruneOAuth();
setInterval(
  () =>
    void pruneOAuth().catch((e: unknown) => {
      console.error("[oauth] prune failed:", e instanceof Error ? e.message : String(e));
    }),
  24 * 60 * 60 * 1000
);
if (config.autoSyncIntervalMs > 0) {
  // Tick failures must be visible: a silently swallowed error here once cost a
  // day of missed syncs. Error messages only - never row data (blind-logs rule).
  setInterval(
    () =>
      void runAutoSync().catch((e: unknown) => {
        console.error("[autosync] tick failed:", e instanceof Error ? e.message : String(e));
      }),
    config.autoSyncIntervalMs
  );
}

if (config.digestIntervalMs > 0 && digestAvailable()) {
  setInterval(
    () =>
      void runDigests().catch((e: unknown) => {
        console.error("[digest] tick failed:", e instanceof Error ? e.message : String(e));
      }),
    config.digestIntervalMs
  );
}

if (config.recurringIntervalMs > 0) {
  setInterval(
    () =>
      void runRecurring().catch((e: unknown) => {
        console.error("[recurring] tick failed:", e instanceof Error ? e.message : String(e));
      }),
    config.recurringIntervalMs
  );
}

const app = express();
app.set("trust proxy", 1);

// Requests still running, for the graceful shutdown at the bottom.
let inFlight = 0;
app.use((_req, res, next) => {
  inFlight++;
  res.once("close", () => inFlight--);
  next();
});

const legacyHosts = new Set(
  config.legacyBaseUrls.flatMap((url) => {
    try {
      return [new URL(url).hostname];
    } catch {
      return [];
    }
  })
);

// /authorize pre-check, ahead of the SDK. The SDK reports a malformed request
// by redirecting to the client's redirect_uri, and registration is anonymous,
// so a crafted link made this domain an open redirect (RFC 9700 4.11.2).
// Such requests get a 400 page here. client_id and redirect_uri stay with the
// SDK, which answers those without redirecting.
app.use(
  "/authorize",
  (req, res, next) => {
    // Sign-in runs on the canonical host only: the browser cookie set here
    // must come back with Google's redirect, which always targets baseUrl.
    // 307 keeps the method and body of a POSTed form.
    if (legacyHosts.has(req.hostname)) return res.redirect(307, `${config.baseUrl}${req.originalUrl}`);
    next();
  },
  express.urlencoded({ extended: false }),
  async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "POST") return next();
    const params = (req.method === "POST" ? req.body : req.query) as Record<string, unknown> | undefined;
    // Idle registrations are pruned (OAuthStore.pruneIdleClients). The SDK
    // answers an unknown client_id with bare JSON in the sign-in window; say
    // what to do instead. Not a redirect: the client cannot be trusted.
    const json = res.json.bind(res);
    const clientParam = typeof params?.client_id === "string" ? params.client_id : "";
    res.json = (body: unknown) => {
      const error = (body as { error?: unknown; error_description?: unknown } | null) ?? {};
      // A published client (CIMD) whose document could not be used: name its
      // host and the reason; retrying helps when the host was only down.
      if (isCimdClientId(clientParam) && (error.error === "invalid_client" || error.error === "server_error")) {
        const why = typeof error.error_description === "string" ? error.error_description.slice(0, 200) : "";
        // On our side too: a document every user of a client is refused for
        // must not be a silent page (the 2026-09 outage was one).
        logEvent("oauth_error", undefined, {
          endpoint: "/authorize",
          status: res.statusCode,
          error: error.error,
          desc: why.slice(0, 160),
          client_id: clientParam.slice(0, 64),
        });
        console.error(`[oauth] /authorize ${res.statusCode} ${String(error.error)}: ${why} (client ${clientParam.slice(0, 64)})`);
        return res
          .set("Cache-Control", "no-store")
          .type("html")
          .send(
            loginPage(
              "",
              undefined,
              `MyFinance could not verify the app published at ${cimdHost(clientParam)}${why ? ` (${why})` : ""}. ` +
                (error.error === "server_error"
                  ? "Try again from your AI client in a minute. If it keeps failing, add MyFinance again and choose Register automatically as the OAuth client."
                  : "In your AI client, add MyFinance again and choose Register automatically as the OAuth client.")
            )
          );
      }
      if (res.statusCode !== 400 || error.error !== "invalid_client") return json(body);
      return res
        .set("Cache-Control", "no-store")
        .type("html")
        .send(
          loginPage(
            "",
            undefined,
            "This connection is no longer registered with MyFinance. Remove MyFinance from your AI client's connectors and add it again."
          )
        );
    };
    // RFC 9207: the SDK's error redirects to the client carry `iss` too
    // (the metadata promises it for every authorization response).
    const redirect = res.redirect.bind(res) as (status: number, url: string) => void;
    res.redirect = ((statusOrUrl: number | string, maybeUrl?: string) => {
      const [status, url] = typeof statusOrUrl === "number" ? [statusOrUrl, maybeUrl ?? ""] : [302, statusOrUrl];
      return redirect(status, withIssuer(url));
    }) as typeof res.redirect;
    const problem = authorizeRequestProblem(params ?? {});
    if (!problem) return next();
    // A pruned client whose request is also malformed: retrying cannot help,
    // re-adding the connector does. Read only on this error path.
    // A published client (CIMD) is not looked up here: an anonymous
    // malformed request must not cost a fetch of whatever URL it names.
    if (clientParam && !isCimdClientId(clientParam) && !(await store.getClient(clientParam))) {
      return res.status(400).json({ error: "invalid_client" }); // rendered by the res.json hook above
    }
    // Leave the same trace as the oauth_error middleware below, so a client
    // refused here is visible on our side. Requests without a client_id
    // (scanners) are not recorded.
    const clientId = typeof params?.client_id === "string" ? params.client_id.slice(0, 64) : "";
    if (clientId) {
      const meta = {
        endpoint: "/authorize",
        status: 400,
        error: problem.errorCode,
        desc: problem.message.slice(0, 160),
        client_id: clientId,
      };
      logEvent("oauth_error", undefined, meta);
      console.error(`[oauth] /authorize 400 ${meta.error}: ${meta.desc} (client ${clientId})`);
    }
    res
      .status(400)
      .set("Cache-Control", "no-store")
      .type("html")
      .send(
        loginPage(
          "",
          undefined,
          `This sign-in request is invalid: ${problem.message} (${problem.errorCode}). Retry from your AI client.`
        )
      );
  }
);

// The SDK answers OAuth endpoint failures itself (no next(err)), so without
// this a refused client leaves no trace: in Sept 2026 every claude.ai
// connector got invalid_client for days and nothing on our side showed it.
// invalid_grant is routine churn (rotated or expired refresh tokens) and goes
// to telemetry only. Error codes and client ids only, never secrets or tokens.
app.use(["/token", "/revoke", "/register"], (req, res, next) => {
  const endpoint = req.baseUrl; // mount path; req.path is "/" here
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode >= 400) {
      const { error, error_description: desc } = (body ?? {}) as { error?: unknown; error_description?: unknown };
      // Parsed by the SDK's own urlencoded parser by the time it responds.
      const clientId = (req.body as { client_id?: unknown } | undefined)?.client_id;
      const meta = {
        endpoint,
        status: res.statusCode,
        error: typeof error === "string" ? error : "unknown",
        desc: typeof desc === "string" ? desc.slice(0, 160) : null,
        client_id: typeof clientId === "string" ? clientId.slice(0, 64) : null,
      };
      logEvent("oauth_error", undefined, meta);
      if (meta.error !== "invalid_grant") {
        console.error(`[oauth] ${meta.endpoint} ${meta.status} ${meta.error}: ${meta.desc ?? ""} (client ${meta.client_id ?? "-"})`);
      }
    }
    return json(body);
  };
  next();
});

// One set of options for the SDK router and for the metadata served ahead of it.
const authOptions = {
  provider,
  issuerUrl: new URL(config.baseUrl),
  resourceServerUrl: new URL(`${config.baseUrl}/mcp`),
  resourceName: "MyFinance MCP",
  scopesSupported: SUPPORTED_SCOPES,
  // The SDK default expires DCR client secrets after 30 days. claude.ai
  // registers once per connector and never re-registers, so day 31 its
  // refresh gets invalid_client and the connector dies (2026-09-24).
  // 0 = never expires (RFC 7591); older rows: see OAuthStore.getClient.
  // Rate limits: the SDK counts per IP, and claude.ai / ChatGPT register
  // and refresh from a few backend egress IPs, so its defaults (20
  // registrations an hour, 50 token calls per 15 min) are effectively a
  // global cap that one busy hour of new connectors would hit. nginx still
  // limits every IP to 5 requests a second on these paths.
  clientRegistrationOptions: { clientSecretExpirySeconds: 0, rateLimit: { windowMs: 60 * 60 * 1000, max: 300 } },
  tokenOptions: { rateLimit: { windowMs: 15 * 60 * 1000, max: 1000 } },
  revocationOptions: { rateLimit: { windowMs: 15 * 60 * 1000, max: 1000 } },
};
// Authorization server metadata: the SDK's, plus what it has no option for.
// client_id_metadata_document_supported: claude.ai's "Use Claude's published
// identity", ChatGPT and Codex use CIMD (src/oauth/cimd.ts) when this is true
// and "none" is an auth method (the SDK lists it).
// authorization_response_iss_parameter_supported: every authorization
// response carries `iss` (RFC 9207: finishLogin, and the /authorize hook
// above for the SDK's error redirects); ChatGPT and Codex then use their
// stable client documents. offline_access: ChatGPT and Claude look for it
// before they count on refresh tokens. The resource's own scopes (protected
// resource metadata) stay SUPPORTED_SCOPES. Mounted ahead of the SDK router,
// which serves the same path.
app.use(
  "/.well-known/oauth-authorization-server",
  metadataHandler({
    ...createOAuthMetadata(authOptions),
    scopes_supported: [...SUPPORTED_SCOPES, OFFLINE_ACCESS],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  })
);
app.use(mcpAuthRouter(authOptions));
// The operator overview shares the Google callback: its handler goes first
// and passes on every state it did not issue.
app.get(GOOGLE_CALLBACK_PATH, adminGoogleCallback);
app.use(adminRouter());
app.use(provider.loginRouter());

// RFC 9728 root variant. The SDK router mounts protected-resource metadata at
// /.well-known/oauth-protected-resource/mcp (path-suffixed form); claude.ai
// also probes the suffix-less root form and treats 404 as "no metadata".
// Same document on both keeps bare-domain installs discoverable.
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: `${config.baseUrl}/mcp`,
    authorization_servers: [ISSUER], // the metadata's issuer, character for character
    scopes_supported: SUPPORTED_SCOPES,
    resource_name: "MyFinance MCP",
  });
});

const bearerAuth = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: `${config.baseUrl}/.well-known/oauth-protected-resource/mcp`,
});

// Stateless Streamable HTTP: one server+transport per request, nothing shared.
// JSON is parsed here only: a global 1 MB parser used to run ahead of the
// SDK's OAuth routers (each brings its own 100 kb parser), so /register stored
// and /authorize held 1 MB bodies. After bearerAuth, so an anonymous request
// never costs a parse.
app.post("/mcp", bearerAuth, express.json({ limit: "1mb" }), async (req, res) => {
  const userId = String(req.auth?.extra?.userId ?? "");
  const server = buildMcpServer(userId, { bankSync: await bankSyncOffered(userId) });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  instrumentTransport(transport, req.body, userId);
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. This server is stateless: POST only." },
    id: null,
  });
};
app.get("/mcp", bearerAuth, methodNotAllowed);
app.delete("/mcp", bearerAuth, methodNotAllowed);

app.get("/health", (_req, res) => {
  res.json({ ok: true, server: SERVER_NAME, version: SERVER_VERSION, commit: config.gitSha });
});

// Public aggregate counters for the landing stats section.
// Counts only, never amounts (privacy spec). Cached to keep a public
// unauthenticated endpoint from becoming a DB load vector: aggregates run in
// SQL, and concurrent cache misses share one recompute.
const STATS_CACHE_MS = 5 * 60 * 1000;
// A timezone is published only once this many users share it: a rare zone
// on a public list points at one person.
const STATS_TZ_MIN_USERS = 3;
type StatsBody = Record<string, unknown>;
let statsCache: { body: StatsBody; at: number } | null = null;
let statsRecompute: Promise<StatsBody> | null = null;

async function computeStats(): Promise<StatsBody> {
  const [transactions, currencies, tzGroups, importEvents, receipts] = await Promise.all([
    db.transaction.count(),
    db.transaction.groupBy({ by: ["currency"] }),
    db.user.groupBy({ by: ["timezone"], _count: { _all: true } }),
    db.event.findMany({
      where: { type: "bank_imported" },
      orderBy: { createdAt: "asc" },
      select: { userId: true, meta: true, createdAt: true },
    }),
    db.transaction.count({ where: { source: "receipt" } }),
  ]);
  // "Files processed" = statement files + receipt photos. LLM clients chunk
  // one statement into several import calls, so raw call counts overstate
  // files ~7x; calls from the same user within 10 minutes are one file.
  // Bank and ZenMoney syncs log the same event type with a provider: they
  // are no file anyone uploaded, and the daily auto-sync inflated the count.
  const FILE_GAP_MS = 10 * 60 * 1000;
  const lastCall = new Map<string, number>();
  let statementFiles = 0;
  for (const e of importEvents) {
    const m = e.meta as { dry_run?: boolean; imported?: number; provider?: string } | null;
    if (!m || m.dry_run || !m.imported || m.provider) continue;
    const key = e.userId ?? "";
    if (e.createdAt.getTime() - (lastCall.get(key) ?? 0) > FILE_GAP_MS) statementFiles++;
    lastCall.set(key, e.createdAt.getTime());
  }
  const timezone_list = tzGroups
    .filter((g) => g.timezone !== "UTC" && g._count._all >= STATS_TZ_MIN_USERS)
    .map((g) => g.timezone)
    .sort();
  return {
    transactions,
    currencies: currencies.length,
    files: statementFiles + receipts,
    timezones: timezone_list.length,
    timezone_list,
  };
}

function currentStats(): Promise<StatsBody> {
  if (statsCache && Date.now() - statsCache.at <= STATS_CACHE_MS) return Promise.resolve(statsCache.body);
  statsRecompute ??= computeStats()
    .then((body) => {
      statsCache = { body, at: Date.now() };
      return body;
    })
    .finally(() => {
      statsRecompute = null;
    });
  return statsRecompute;
}

app.get("/api/stats", async (_req, res) => {
  try {
    const body = await currentStats();
    res.set("Cache-Control", "public, max-age=300").json(body);
  } catch {
    res.status(500).json({ error: "stats_unavailable" });
  }
});

// Bank consent return leg (Enable Banking). The bank redirects the user here
// after they approve or decline access; ?state ties the visit back to the
// pending connection created by connect_bank action=start.
//
// Nothing is bound on arrival. A consent link can be forwarded: whoever
// started it (any MyFinance account) would get read access to the bank of
// whoever completes it. So the page names the MyFinance account that is about
// to receive the access and binds only on an explicit confirm, which must
// come from this same browser (a cookie set here), so the link's starter
// cannot confirm it from elsewhere.
const BANK_LINK_TTL_MS = 30 * 60 * 1000;
const BANK_CONFIRM_TTL_MS = 10 * 60 * 1000;
const BANK_CONFIRM_COOKIE = "mf_bank";
const BANK_PATH = "/connect/enablebanking";
const pageShell = (title: string, inner: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#fafaf7;color:#1c1c1a;margin:0}main{max-width:420px;padding:40px;text-align:center}h1{font-size:22px;margin:0 0 12px}p{line-height:1.5;color:#555}.mark{font-size:40px;margin-bottom:16px}form{display:flex;gap:10px;justify-content:center;margin-top:24px}button{padding:11px 20px;border-radius:8px;font-size:15px;cursor:pointer;border:1px solid #1c1c1a}.go{background:#1c1c1a;color:#fff}.stop{background:#fff;color:#1c1c1a}.who{font-size:17px;color:#1c1c1a}</style></head><body><main>${inner}</main></body></html>`;
const callbackPage = (title: string, body: string, ok: boolean) =>
  pageShell(title, `<div class="mark">${ok ? "&#10003;" : "&#10007;"}</div><h1>${title}</h1><p>${body}</p>`);
const confirmPage = (state: string, bank: string, account: string) =>
  pageShell(
    "Confirm bank connection",
    `<h1>Connect ${escapeHtml(bank)} to MyFinance?</h1>` +
      `<p>Read-only access to your ${escapeHtml(bank)} transactions and balances goes to the MyFinance account</p>` +
      `<p class="who"><b>${escapeHtml(account)}</b></p>` +
      `<p>Continue only if this is your account. If someone sent you this link, cancel: they would see your transactions.</p>` +
      `<form method="post" action="${BANK_PATH}/confirm"><input type="hidden" name="state" value="${escapeHtml(state)}">` +
      `<button class="go" name="decision" value="connect">Connect</button><button class="stop" name="decision" value="cancel">Cancel</button></form>`
  );

type BankLinkMeta = Record<string, unknown> & {
  state?: string;
  startedAt?: number; // connect_bank action=start; the link's 30 minutes run from here
  aspsp?: { name?: string };
  pendingCode?: string; // the bank's authorization code, encrypted like session ids
  codeAt?: number;
  confirmHash?: string;
};

async function pendingBankLink(state: string) {
  const link = (await db.bankConnection.findMany({ where: { provider: "enablebanking" } })).find(
    (c) => ((c.meta ?? {}) as BankLinkMeta).state === state
  );
  if (!link) return undefined;
  const meta = (link.meta ?? {}) as BankLinkMeta;
  // A consent link is good for one attempt: expiry, a decline, a cancel or a
  // failure drops the state (and any code held for the confirm step), so
  // whoever still holds the URL cannot complete it later.
  const { state: _state, pendingCode: _code, codeAt: _codeAt, confirmHash: _confirm, ...rest } = meta;
  const endAttempt = (lastError: string) =>
    db.bankConnection.update({
      where: { id: link.id },
      data: { status: "error", lastError: lastError.slice(0, 500), meta: rest as object },
    });
  return { link, meta, rest, endAttempt };
}

app.get(`${BANK_PATH}/callback`, async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query as Record<string, string | undefined>;
  const fail = (status: number, title: string, body: string) =>
    res.status(status).type("html").send(callbackPage(title, body, false));
  if (!state) return fail(400, "Missing state", "This link is incomplete. Restart the connection from your AI chat.");
  const pending = await pendingBankLink(state);
  if (!pending) {
    return fail(400, "Unknown or expired link", "Restart the connection from your AI chat with connect_bank.");
  }
  const { link, meta, endAttempt } = pending;
  // From the start, not from the last write: reloading this page rewrites
  // the row and must not keep the link alive.
  if (Date.now() - (meta.startedAt ?? link.updatedAt.getTime()) > BANK_LINK_TTL_MS) {
    await endAttempt("Bank authorization link expired before consent");
    return fail(400, "Link expired", "Link expired, restart from your AI chat with connect_bank.");
  }
  if (error) {
    await endAttempt(`Bank authorization failed: ${errorDescription || error}`);
    return fail(400, "Authorization declined", "No access was granted. You can retry from your AI chat at any time.");
  }
  if (!code) return fail(400, "Missing code", "The bank did not return an authorization code. Please retry.");
  const owner = await db.user.findUnique({ where: { id: link.userId }, select: { email: true } });
  if (!owner) return fail(400, "Unknown or expired link", "Restart the connection from your AI chat with connect_bank.");
  // Hold the bank's code until the confirm; this browser gets the key to it.
  // A reload of this page keeps the held code as stored (encryption is
  // randomized, so re-encrypting would void a confirm already on its way)
  // and its clock; only the browser key is renewed.
  let held: string | undefined;
  try {
    held = meta.pendingCode && decryptToken(meta.pendingCode) === code ? meta.pendingCode : undefined;
  } catch {
    held = undefined;
  }
  const browserKey = randomBytes(32).toString("base64url");
  await db.bankConnection.update({
    where: { id: link.id },
    data: {
      meta: {
        ...meta,
        startedAt: meta.startedAt ?? link.updatedAt.getTime(),
        pendingCode: held ?? encryptToken(code),
        codeAt: held ? meta.codeAt : Date.now(),
        confirmHash: sha256(browserKey).toString("hex"),
      } as object,
    },
  });
  res.cookie(BANK_CONFIRM_COOKIE, browserKey, {
    httpOnly: true,
    sameSite: "lax",
    path: BANK_PATH,
    maxAge: BANK_CONFIRM_TTL_MS,
    secure: config.baseUrl.startsWith("https"),
  });
  res
    .set("Cache-Control", "no-store")
    .type("html")
    .send(confirmPage(state, meta.aspsp?.name ?? "your bank", maskEmail(owner.email)));
});

app.post(`${BANK_PATH}/confirm`, express.urlencoded({ extended: false }), async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const state = typeof body.state === "string" ? body.state : "";
  const fail = (status: number, title: string, text: string) =>
    res.status(status).type("html").send(callbackPage(title, text, false));
  const pending = state ? await pendingBankLink(state) : undefined;
  if (!pending?.meta.pendingCode || !pending.meta.confirmHash) {
    // Also the second request of a double click, which finds the first one
    // finishing (or finished) the connection.
    return fail(
      400,
      "Link already used or expired",
      "If you just confirmed, go back to your AI chat and run sync_bank. Otherwise restart the connection with connect_bank."
    );
  }
  const { link, meta, rest, endAttempt } = pending;
  const browserKey = readCookie(req, BANK_CONFIRM_COOKIE);
  if (!browserKey || !timingSafeEqual(sha256(browserKey), Buffer.from(meta.confirmHash!, "hex"))) {
    return fail(400, "Different browser", "Confirm in the browser where you approved access at your bank, or restart from your AI chat.");
  }
  res.clearCookie(BANK_CONFIRM_COOKIE, { path: BANK_PATH });
  // Claim the code before anything is written: of two confirms (a double
  // click, or Connect then Cancel) one takes it, the other finds it gone,
  // so no second request can overwrite what the first one did. The state
  // goes with it: a reload of the bank's return page cannot re-arm the link.
  const { pendingCode: _taken, state: _state, ...claimed } = meta;
  const { count: won } = await db.bankConnection.updateMany({
    where: { id: link.id, meta: { path: ["pendingCode"], equals: meta.pendingCode! } },
    data: { meta: claimed as object },
  });
  if (won !== 1) {
    return fail(
      400,
      "Link already used or expired",
      "If you just confirmed, go back to your AI chat and run sync_bank. Otherwise restart the connection with connect_bank."
    );
  }
  if (Date.now() - (meta.codeAt ?? 0) > BANK_CONFIRM_TTL_MS) {
    await endAttempt("Bank connection was not confirmed in time");
    return fail(400, "Link expired", "Link expired, restart from your AI chat with connect_bank.");
  }
  if (body.decision !== "connect") {
    await endAttempt("Bank connection cancelled at the confirmation step");
    return res
      .type("html")
      .send(callbackPage("Not connected", "Nothing was connected and no access was granted to anyone.", false));
  }
  let bankCode: string;
  try {
    bankCode = decryptToken(meta.pendingCode!);
  } catch {
    // A rotated TOKEN_ENC_KEY or a damaged row; its own text names ZenMoney.
    await endAttempt("The bank authorization could not be read back. Reconnect with connect_bank.");
    return fail(502, "Connection failed", "Could not finish the bank connection. Retry from your AI chat.");
  }
  try {
    const session = await ebCreateSession(bankCode);
    if (!session.accounts?.length) {
      // The bank approved the sign-in but shared no account (the provider's
      // restricted tier does this). "Bank connected" here sent users to a
      // sync that could only fail; say what happened and what works instead.
      await ebDeleteSession(session.session_id).catch((e: unknown) => {
        console.error("[enablebanking] session revoke failed:", e instanceof Error ? e.message : String(e));
      });
      await endAttempt(
        "The bank approved the sign-in but shared no accounts. Direct sync is not available for this bank yet: import a statement with import_transactions instead."
      );
      return res
        .type("html")
        .send(
          callbackPage(
            "No accounts were shared",
            "Your bank approved the sign-in but shared no accounts with MyFinance, so there is nothing to sync. Direct bank sync is not available for this bank yet. In your AI chat, send a statement export instead (CSV, PDF or screenshots of the transactions): it works with any bank.",
            false
          )
        );
    }
    await db.bankConnection.update({
      where: { id: link.id },
      data: {
        tokenEnc: encryptToken(session.session_id),
        status: "active",
        lastError: null,
        meta: JSON.parse(
          JSON.stringify({
            aspsp: session.aspsp ?? rest.aspsp,
            validUntil: session.access?.valid_until,
            accountsInfo: session.accounts,
          })
        ),
      },
    });
    return res
      .type("html")
      .send(
        callbackPage(
          "Bank connected",
          `${session.accounts.length} account(s) authorized. Go back to your AI chat and run sync_bank to import transactions.`,
          true
        )
      );
  } catch (e) {
    await endAttempt(e instanceof Error ? e.message : String(e));
    return fail(502, "Connection failed", "Could not finish the bank connection. Retry from your AI chat.");
  }
});

// Email summary unsubscribe. GET only shows the button: mail scanners open
// links, and a GET that unsubscribed would stop summaries for people who
// never clicked. POST does it, from the button or from the mail client's
// one-click unsubscribe (RFC 8058, List-Unsubscribe-Post).
const DIGEST_PATH = "/digest/unsubscribe";
const badUnsubscribe = () =>
  callbackPage(
    "Link not valid",
    "This unsubscribe link is incomplete or damaged. You can also say \"turn off the MyFinance email summary\" in your AI chat.",
    false
  );
const unsubscribeParams = (req: express.Request) => {
  const { u, t } = req.query as Record<string, unknown>;
  return typeof u === "string" && typeof t === "string" && validUnsubscribe(u, t) ? { u, t } : null;
};
app.get(DIGEST_PATH, (req, res) => {
  res.set("Cache-Control", "no-store");
  const p = unsubscribeParams(req);
  if (!p) return res.status(400).type("html").send(badUnsubscribe());
  res
    .type("html")
    .send(
      pageShell(
        "Stop the email summary",
        `<h1>Stop the MyFinance email summary?</h1><p>No more weekly or monthly summaries by email. Your records stay as they are.</p>` +
          `<form method="post" action="${DIGEST_PATH}?u=${escapeHtml(encodeURIComponent(p.u))}&amp;t=${escapeHtml(encodeURIComponent(p.t))}">` +
          `<button class="go">Stop the emails</button></form>`
      )
    );
});
app.post(DIGEST_PATH, express.urlencoded({ extended: false }), async (req, res) => {
  res.set("Cache-Control", "no-store");
  const p = unsubscribeParams(req);
  if (!p) return res.status(400).type("html").send(badUnsubscribe());
  await unsubscribe(p.u);
  res
    .type("html")
    .send(callbackPage("Email summary stopped", "You will get no more summaries. Turn them back on any time from your AI chat.", true));
});

app.get("/", (_req, res) => {
  res
    .type("text/plain")
    .send(`MyFinance MCP - personal finance for your AI.\nMCP endpoint: ${config.baseUrl}/mcp\n`);
});

const httpServer = app.listen(config.port, () => {
  console.log(`[myfinancemcp] ${SERVER_VERSION} listening on :${config.port}, issuer ${config.baseUrl}`);
});

// Every deploy's docker compose up -d sends SIGTERM and kills 10 s later.
// Stop accepting, let in-flight requests (imports, token rotations) finish
// for up to 8 s, close the pool, exit 0.
const SHUTDOWN_GRACE_MS = 8_000;
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[myfinancemcp] ${signal}: draining ${inFlight} request(s)`);
  httpServer.close();
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (inFlight > 0 && Date.now() < deadline) await Bun.sleep(50);
  if (inFlight > 0) console.error(`[myfinancemcp] exiting with ${inFlight} request(s) still running`);
  await db.$disconnect().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
