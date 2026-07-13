import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const SERVER_NAME = "financemcp";
export const SERVER_VERSION = "0.1.0-gate-a";

export function buildMcpServer(userId: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description:
        "Health check for the FinanceMCP connection. Returns server identity, version, and the authenticated user.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            server: SERVER_NAME,
            version: SERVER_VERSION,
            user: userId,
            time: new Date().toISOString(),
          }),
        },
      ],
    })
  );

  return server;
}
