import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config, assertConfig } from "./config.js";
import { OAuthStore } from "./oauth/store.js";
import { FinanceOAuthProvider } from "./oauth/provider.js";
import { buildMcpServer, SERVER_NAME, SERVER_VERSION } from "./mcp.js";

assertConfig();

const store = new OAuthStore(config.stateDir);
const provider = new FinanceOAuthProvider(store, {
  email: config.userEmail,
  passwordHash: config.passwordHash,
});

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: new URL(config.baseUrl),
    resourceServerUrl: new URL(`${config.baseUrl}/mcp`),
    resourceName: "FinanceMCP",
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
  const userId = String(req.auth?.extra?.userId ?? "unknown");
  const server = buildMcpServer(userId);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
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

app.get("/", (_req, res) => {
  res
    .type("text/plain")
    .send(`FinanceMCP - personal finance for your AI.\nMCP endpoint: ${config.baseUrl}/mcp\n`);
});

app.listen(config.port, () => {
  console.log(`[financemcp] ${SERVER_VERSION} listening on :${config.port}, issuer ${config.baseUrl}`);
});
