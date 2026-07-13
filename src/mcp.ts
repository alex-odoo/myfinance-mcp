import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFinanceTools } from "./tools";
import { DASHBOARD_URI, DASHBOARD_MIME, DASHBOARD_HTML } from "./ui";

export { SERVER_NAME, SERVER_VERSION } from "./version";
import { SERVER_NAME, SERVER_VERSION } from "./version";

export function buildMcpServer(userId: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerFinanceTools(server, userId);
  server.registerResource(
    "dashboard",
    DASHBOARD_URI,
    {
      description: "FinanceMCP dashboard: budgets, trends, summary, accounts",
      mimeType: DASHBOARD_MIME,
      _meta: { ui: { prefersBorder: true } },
    },
    async () => ({
      contents: [{ uri: DASHBOARD_URI, mimeType: DASHBOARD_MIME, text: DASHBOARD_HTML }],
    })
  );
  return server;
}
