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
      const [transactions, currencies, tzRows, imports, dryRuns] = await Promise.all([
        db.transaction.count(),
        db.transaction.findMany({ distinct: ["currency"], select: { currency: true } }),
        db.user.findMany({ distinct: ["timezone"], select: { timezone: true } }),
        db.event.count({ where: { type: "bank_imported" } }),
        db.event.count({ where: { type: "bank_imported", meta: { path: ["dry_run"], equals: true } } }),
      ]);
      const timezone_list = tzRows.map((r) => r.timezone).filter((tz) => tz !== "UTC");
      statsCache = {
        at: Date.now(),
        body: {
          transactions,
          currencies: currencies.length,
          files: imports - dryRuns,
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

app.get("/", (_req, res) => {
  res
    .type("text/plain")
    .send(`MyFinance MCP - personal finance for your AI.\nMCP endpoint: ${config.baseUrl}/mcp\n`);
});

app.listen(config.port, () => {
  console.log(`[myfinancemcp] ${SERVER_VERSION} listening on :${config.port}, issuer ${config.baseUrl}`);
});
