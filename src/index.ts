import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config, assertConfig } from "./config";
import { db } from "./db";
import { OAuthStore } from "./oauth/store";
import { FinanceOAuthProvider } from "./oauth/provider";
import { bootstrapUser } from "./users";
import { buildMcpServer, SERVER_NAME, SERVER_VERSION } from "./mcp";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "./categories";
import { instrumentTransport, pruneOldEvents } from "./telemetry";
import { ebCreateSession } from "./enablebanking/client";
import { runAutoSync } from "./autosync";
import { encryptToken } from "./zenmoney/crypto";

assertConfig();

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
  setInterval(() => void runAutoSync().catch(() => {}), config.autoSyncIntervalMs);
}

const provider = new FinanceOAuthProvider(new OAuthStore());

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: new URL(config.baseUrl),
    resourceServerUrl: new URL(`${config.baseUrl}/mcp`),
    resourceName: "MyFinance MCP",
    scopesSupported: ["finance"],
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
    scopes_supported: ["finance"],
    resource_name: "MyFinance MCP",
  });
});

const bearerAuth = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: `${config.baseUrl}/.well-known/oauth-protected-resource/mcp`,
});

// Stateless Streamable HTTP: one server+transport per request, nothing shared.
app.post("/mcp", bearerAuth, async (req, res) => {
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
  res.json({ ok: true, server: SERVER_NAME, version: SERVER_VERSION });
});

// Public aggregate counters for the landing stats section.
// Counts only, never amounts (privacy spec). Cached to keep a public
// unauthenticated endpoint from becoming a DB load vector.
let statsCache: { body: Record<string, unknown>; at: number } | null = null;
const STATS_CACHE_MS = 5 * 60 * 1000;
app.get("/api/stats", async (_req, res) => {
  try {
    if (!statsCache || Date.now() - statsCache.at > STATS_CACHE_MS) {
      const [transactions, currencies, tzRows, importEvents, receipts] = await Promise.all([
        db.transaction.count(),
        db.transaction.findMany({ distinct: ["currency"], select: { currency: true } }),
        db.user.findMany({ distinct: ["timezone"], select: { timezone: true } }),
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
      const timezone_list = tzRows.map((r) => r.timezone).filter((tz) => tz !== "UTC");
      statsCache = {
        at: Date.now(),
        body: {
          transactions,
          currencies: currencies.length,
          files: statementFiles + receipts,
          timezones: timezone_list.length,
          timezone_list,
        },
      };
    }
    res.set("Cache-Control", "public, max-age=300").json(statsCache.body);
  } catch {
    res.status(500).json({ error: "stats_unavailable" });
  }
});

// Bank consent return leg (Enable Banking). The bank redirects the user here
// after they approve or decline access; ?state ties the visit back to the
// pending connection created by connect_bank action=start.
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
  if (error) {
    const message = `Bank authorization failed: ${errorDescription || error}`;
    await db.bankConnection.update({
      where: { id: pending.id },
      data: { status: "error", lastError: message.slice(0, 500) },
    });
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
    const message = e instanceof Error ? e.message : String(e);
    await db.bankConnection.update({
      where: { id: pending.id },
      data: { status: "error", lastError: message.slice(0, 500) },
    });
    return fail(502, "Connection failed", "Could not finish the bank connection. Retry from your AI chat.");
  }
});

app.get("/", (_req, res) => {
  res
    .type("text/plain")
    .send(`MyFinance MCP - personal finance for your AI.\nMCP endpoint: ${config.baseUrl}/mcp\n`);
});

app.listen(config.port, () => {
  console.log(`[myfinancemcp] ${SERVER_VERSION} listening on :${config.port}, issuer ${config.baseUrl}`);
});
