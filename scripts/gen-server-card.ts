/**
 * Generate site/.well-known/mcp/server-card.json (SEP-1649) from the real
 * server: connects an in-memory MCP client to buildMcpServer and dumps
 * tools/resources. Smithery and other scanners read this card instead of
 * scanning the live endpoint (which requires OAuth and rejects GET).
 * Re-run after any tool change: bun run scripts/gen-server-card.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer, SERVER_NAME, SERVER_VERSION } from "../src/mcp";

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = buildMcpServer("00000000-0000-0000-0000-000000000000");
await server.connect(serverTransport);

const client = new Client({ name: "server-card-gen", version: "1.0.0" });
await client.connect(clientTransport);

const tools = (await client.listTools()).tools.map((t) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: t.inputSchema,
  annotations: t.annotations,
}));
const resources = await client
  .listResources()
  .then((r) => r.resources)
  .catch(() => []);

const card = {
  serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  authentication: { required: true, schemes: ["oauth2"] },
  tools,
  resources,
  prompts: [],
};

mkdirSync("site/.well-known/mcp", { recursive: true });
writeFileSync("site/.well-known/mcp/server-card.json", JSON.stringify(card, null, 2) + "\n");
console.log(`server-card.json: ${tools.length} tools, ${resources.length} resources`);
await client.close();
await server.close();
process.exit(0);
