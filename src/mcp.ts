import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFinanceTools } from "./tools";
import { DASHBOARD_URI, DASHBOARD_MIME, DASHBOARD_HTML } from "./ui";
import { config } from "./config";

export { SERVER_NAME, SERVER_VERSION } from "./version";
import { SERVER_NAME, SERVER_VERSION } from "./version";

/**
 * Read by clients at initialize. New accounts start on EUR/UTC, and "today",
 * "this month" and every total depend on both, so the first conversation sets
 * them instead of the server guessing.
 */
const INSTRUCTIONS =
  "MyFinance MCP stores the user's money records and computes every total server-side: answer money questions with get_summary, get_trends, get_budget_progress and get_accounts, never by adding up rows yourself. " +
  "On first use call get_settings; if it reports default settings, ask the user which currency they think in and where they live, then call update_settings once with base_currency and timezone. " +
  "Bank statements go to import_transactions as ONE call with every row; single purchases go to log_expense.";

export function buildMcpServer(userId: string): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: "MyFinance MCP",
      websiteUrl: config.baseUrl,
      // Connector icon (MCP icons spec): hosts render this in the connector UI.
      icons: [
        { src: `${config.baseUrl}/apple-touch-icon.png`, mimeType: "image/png", sizes: ["180x180"] },
        { src: `${config.baseUrl}/favicon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
      ],
    },
    { instructions: INSTRUCTIONS }
  );
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
