import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LEGACY_TOOLS, registerFinanceTools, type FinanceToolOptions } from "./tools";
import { DASHBOARD_URI, DASHBOARD_MIME, DASHBOARD_HTML } from "./ui";
import { config } from "./config";
import { digestAvailable } from "./digest";

export { SERVER_NAME, SERVER_VERSION } from "./version";
import { SERVER_NAME, SERVER_VERSION } from "./version";

/**
 * Read by clients at initialize. New accounts start on EUR/UTC, and "today",
 * "this month" and every total depend on both, so the first conversation sets
 * them instead of the server guessing.
 */
const instructions = (digest: boolean) =>
  "MyFinance MCP stores the user's money records and computes every total server-side: answer money questions with get_summary, get_budget_progress, get_recurring and get_accounts, never by adding up rows yourself. " +
  "On first use call get_settings; if it reports default settings, ask the user which currency they think in and where they live, then call update_settings once with base_currency and timezone. " +
  "Bank statements go to import_transactions as ONE call with every row; single purchases go to log_expense. " +
  "No bank connection is needed: for bank data from any bank, ask the user for a statement export (CSV, PDF or screenshots) and import it." +
  (digest
    ? " When the user has a few records and get_settings shows email_digest not_chosen, you may offer a weekly or monthly email summary once; turn it on only after a clear yes."
    : "");

export function buildMcpServer(userId: string, options: FinanceToolOptions): McpServer {
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
    { instructions: instructions(digestAvailable()) }
  );
  registerFinanceTools(server, userId, options);
  hideTools(server, LEGACY_TOOLS);
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

/**
 * Leaves `hidden` out of tools/list while they stay callable. The SDK has no
 * hidden tools, so the list handler McpServer installed is wrapped; it sits
 * in a private map of the protocol layer. If an SDK update moves it, this
 * throws when the first server is built (every request, and the e2e gate),
 * instead of silently listing the old tools again.
 */
function hideTools(server: McpServer, hidden: ReadonlySet<string>): void {
  type Handler = (request: unknown, extra: unknown) => Promise<unknown>;
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, Handler> })._requestHandlers;
  const list = handlers?.get("tools/list");
  if (!handlers || !list) throw new Error("MCP SDK internals changed: no tools/list handler to wrap (hideTools in src/mcp.ts)");
  handlers.set("tools/list", async (request, extra) => {
    const result = (await list(request, extra)) as { tools: Array<{ name: string }> };
    return { ...result, tools: result.tools.filter((tool) => !hidden.has(tool.name)) };
  });
}
