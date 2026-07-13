import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFinanceTools } from "./tools";

export { SERVER_NAME, SERVER_VERSION } from "./version";
import { SERVER_NAME, SERVER_VERSION } from "./version";

export function buildMcpServer(userId: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerFinanceTools(server, userId);
  return server;
}
