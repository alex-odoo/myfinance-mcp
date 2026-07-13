import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFinanceTools } from "./tools";

export const SERVER_NAME = "financemcp";
export const SERVER_VERSION = "0.2.0-m1";

export function buildMcpServer(userId: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerFinanceTools(server, userId);
  return server;
}
