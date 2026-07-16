import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFinanceTools } from "./tools";
import { DASHBOARD_URI, DASHBOARD_MIME, DASHBOARD_HTML } from "./ui";
import { config } from "./config";

export { SERVER_NAME, SERVER_VERSION } from "./version";
import { SERVER_NAME, SERVER_VERSION } from "./version";

export function buildMcpServer(userId: string): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    title: "MyFinance MCP",
    websiteUrl: config.baseUrl,
    // Connector icon (MCP icons spec): hosts render this in the connector UI.
    icons: [
      { src: `${config.baseUrl}/apple-touch-icon.png`, mimeType: "image/png", sizes: ["180x180"] },
      { src: `${config.baseUrl}/favicon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
    ],
  });
  registerFinanceTools(server, userId);
  server.registerResource(
    "dashboard",
    DASHBOARD_URI,
    {
      description: "MyFinance MCP dashboard: budgets, trends, summary, accounts",
      mimeType: DASHBOARD_MIME,
      _meta: { ui: { prefersBorder: true } },
    },
    async () => ({
      contents: [{ uri: DASHBOARD_URI, mimeType: DASHBOARD_MIME, text: DASHBOARD_HTML }],
    })
  );
  return server;
}
