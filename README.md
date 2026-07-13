# FinanceMCP

Personal finance tracking through a remote MCP server. The user's own AI client
(Claude, ChatGPT, Cursor) is the UI: log expenses by voice or receipt photo, ask
for stats in plain language. Full spec: Obsidian vault `Projects/FinanceMCP.md`.

Status: **Gate A** - remote Streamable HTTP transport + OAuth 2.0/PKCE + `ping` tool.

## Stack

Bun + TypeScript + `@modelcontextprotocol/sdk` (Streamable HTTP, stateless) +
Express + OAuth 2.1 (PKCE, dynamic client registration) + JSON file state
(moves to Supabase in M1). Docker on Hetzner behind nginx.

## Run locally

```bash
cp .env.example .env   # fill FINANCE_MCP_EMAIL + FINANCE_MCP_PASSWORD_HASH
bun install
bun run dev            # server on :8788
bun run e2e            # self-contained Gate A proof (19 checks)
bun run e2e https://finance.rteam.agency   # same suite against prod (E2E_EMAIL/E2E_PASSWORD env)
```

Generate a password hash:

```bash
bun -e "console.log(await Bun.password.hash(process.argv[1]))" 'your-password'
```

## Endpoints

- `POST /mcp` - MCP Streamable HTTP (Bearer token required)
- `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp` - discovery
- `/authorize`, `/token`, `/register`, `/revoke`, `/login` - OAuth
- `/health` - liveness

## Connect from Claude

Claude.ai -> Settings -> Connectors -> Add custom connector ->
`https://finance.rteam.agency/mcp` -> sign in. Then ask Claude to "ping FinanceMCP".

## Deploy

`./deploy.sh "what changed"` - typecheck + e2e gate, rsync to rteam-ai, docker
compose rebuild, nginx sync, health check. Never edit code on the box.
