import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config, assertConfig } from "./config";
import { db, logEvent } from "./db";
import { OAuthStore } from "./oauth/store";
import { FinanceOAuthProvider, SUPPORTED_SCOPES, authorizeRequestProblem } from "./oauth/provider";
import { loginPage } from "./oauth/login";
import { bootstrapUser } from "./users";
import { buildMcpServer, SERVER_NAME, SERVER_VERSION } from "./mcp";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "./categories";
import { instrumentTransport, pruneOldEvents } from "./telemetry";
import { ebCreateSession } from "./enablebanking/client";
import { runAutoSync } from "./autosync";
import { encryptToken } from "./zenmoney/crypto";

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
await pruneOldEvents();
setInterval(() => void pruneOldEvents(), 24 * 60 * 60 * 1000);
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

const provider = new FinanceOAuthProvider(new OAuthStore());

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
  (req, res, next) => {
    if (req.method !== "GET" && req.method !== "POST") return next();
    const params = (req.method === "POST" ? req.body : req.query) as Record<string, unknown> | undefined;
    const problem = authorizeRequestProblem(params ?? {});
    if (!problem) return next();
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

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: new URL(config.baseUrl),
    resourceServerUrl: new URL(`${config.baseUrl}/mcp`),
    resourceName: "MyFinance MCP",
    scopesSupported: SUPPORTED_SCOPES,
    // The SDK default expires DCR client secrets after 30 days. claude.ai
    // registers once per connector and never re-registers, so day 31 its
    // refresh gets invalid_client and the connector dies (2026-09-24).
    // 0 = never expires (RFC 7591); older rows: see OAuthStore.getClient.
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  })
);
app.use(provider.loginRouter());

// RFC 9728 root variant. The SDK router mounts protected-resource metadata at
// /.well-known/oauth-protected-resource/mcp (path-suffixed form); claude.ai
// also probes the suffix-less root form and treats 404 as "no metadata".
// Same document on both keeps bare-domain installs discoverable.
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: `${config.baseUrl}/mcp`,
    authorization_servers: [config.baseUrl],
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
  const server = buildMcpServer(userId);
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
  const FILE_GAP_MS = 10 * 60 * 1000;
  const lastCall = new Map<string, number>();
  let statementFiles = 0;
  for (const e of importEvents) {
    const m = e.meta as { dry_run?: boolean; imported?: number } | null;
    if (!m || m.dry_run || !m.imported) continue;
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
const BANK_LINK_TTL_MS = 30 * 60 * 1000;
const callbackPage = (title: string, body: string, ok: boolean) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#fafaf7;color:#1c1c1a;margin:0}main{max-width:420px;padding:40px;text-align:center}h1{font-size:22px;margin:0 0 12px}p{line-height:1.5;color:#555}.mark{font-size:40px;margin-bottom:16px}</style></head><body><main><div class="mark">${ok ? "&#10003;" : "&#10007;"}</div><h1>${title}</h1><p>${body}</p></main></body></html>`;

app.get("/connect/enablebanking/callback", async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query as Record<string, string | undefined>;
  const fail = (status: number, title: string, body: string) =>
    res.status(status).type("html").send(callbackPage(title, body, false));
  if (!state) return fail(400, "Missing state", "This link is incomplete. Restart the connection from your AI chat.");
  const pending = (await db.bankConnection.findMany({ where: { provider: "enablebanking" } })).find(
    (c) => ((c.meta ?? {}) as { state?: string }).state === state
  );
  if (!pending) {
    return fail(400, "Unknown or expired link", "Restart the connection from your AI chat with connect_bank.");
  }
  const meta = (pending.meta ?? {}) as Record<string, unknown>;
  // A consent link is good for one attempt within BANK_LINK_TTL_MS: expiry,
  // a decline or a failure drops the state, so whoever still holds the URL
  // cannot complete it later.
  const { state: _usedState, ...metaWithoutState } = meta;
  const endAttempt = (lastError: string) =>
    db.bankConnection.update({
      where: { id: pending.id },
      data: { status: "error", lastError: lastError.slice(0, 500), meta: metaWithoutState as object },
    });
  if (Date.now() - pending.updatedAt.getTime() > BANK_LINK_TTL_MS) {
    await endAttempt("Bank authorization link expired before consent");
    return fail(400, "Link expired", "Link expired, restart from your AI chat with connect_bank.");
  }
  if (error) {
    await endAttempt(`Bank authorization failed: ${errorDescription || error}`);
    return fail(400, "Authorization declined", "No access was granted. You can retry from your AI chat at any time.");
  }
  if (!code) return fail(400, "Missing code", "The bank did not return an authorization code. Please retry.");
  try {
    const session = await ebCreateSession(code);
    await db.bankConnection.update({
      where: { id: pending.id },
      data: {
        tokenEnc: encryptToken(session.session_id),
        status: "active",
        lastError: null,
        meta: JSON.parse(
          JSON.stringify({
            aspsp: session.aspsp ?? meta.aspsp,
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
          `${session.accounts?.length ?? 0} account(s) authorized. Go back to your AI chat and run sync_bank to import transactions.`,
          true
        )
      );
  } catch (e) {
    await endAttempt(e instanceof Error ? e.message : String(e));
    return fail(502, "Connection failed", "Could not finish the bank connection. Retry from your AI chat.");
  }
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
