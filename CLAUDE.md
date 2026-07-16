# CLAUDE.md - MyFinance MCP

> Compact per rule 9. Full spec: Obsidian vault `Projects/MyFinanceMCP.md`.
> Rteam-internal product, open source (MIT). First user: Alex (self-dogfood).

## What it is

Personal finance tracking through a **remote MCP server**. The user's own AI
client (Claude, ChatGPT, Cursor) is the UI: log expenses by voice or receipt
photo, ask for stats in plain language. No app, no forms. The server owns the
DATA and the MATH; the AI client owns the ADVICE.

## Stack

- **Bun + TypeScript** + `@modelcontextprotocol/sdk` (Streamable HTTP, stateless) + Express
- **OAuth 2.1** - PKCE + dynamic client registration
- **Prisma + Supabase Postgres 16** (project `myfinance-mcp`, org Rteam Agency, eu-central-1, ref `utplzxwmxaymhehkkekl`)
- **Docker on Hetzner** - server `rteam-ai` (23.88.115.126), behind nginx
- Repo: `git@github.com:alex-odoo/myfinance-mcp.git`, branch `main`

## Domains (both live)

- `https://myfinance-mcp.com` - primary (OAuth issuer/BASE_URL since 2026-07-16); landing = repo `site/`, static on same origin
- `https://finance.rteam.agency` - legacy, still serving (old connectors)
- `myfinancemcp.com` - defensive twin, GoDaddy Forwarding 301 -> primary (NOT our nginx; DNS stays on GoDaddy parking IPs)
- MCP endpoint: `POST /mcp` (Bearer token). Connect via Claude.ai -> Connectors
  -> Add custom connector -> `https://myfinance-mcp.com/mcp` -> sign in
  (OAuth Client ID/Secret fields stay EMPTY).

## Deploy (rule 7 - never manual)

```bash
./deploy.sh "what changed"
```

One-way Mac -> rteam-ai: local `bun run build` + `bun run e2e` gate, commit +
push `main`, rsync to `/opt/myfinance-mcp`, `docker compose build && up -d`,
nginx sync, health check. **Never edit code on the box.** Secrets live in
`/opt/myfinance-mcp/app.env` (chmod 600) - not in repo, not rsynced.

## Local dev

```bash
bun install
bun run dev            # server on :8788
bun run e2e            # self-contained E2E proof
bun run e2e https://myfinance-mcp.com      # same suite vs prod (E2E_EMAIL/E2E_PASSWORD)
bun run lint
```

Password hash: `bun -e "console.log(await Bun.password.hash(process.argv[1]))" 'pw'`

## Design rules (simplicity contract - see vault)

- **Zero setup, no forms, no category picking.** Natural language / photo IS the input; category is a fixed enum the server enforces.
- **Money = `numeric`, never float.** All statistics are SQL aggregates over `amount_base`; the LLM never does arithmetic over raw records.
- **Multi-currency invisible:** store original amount + currency + fx rate frozen at log time; summaries answer in base currency.
- **Silence over noise.** Budget alerts only when a budget exists and is exceeded.
- **Receipt photos never reach the server** - Claude vision parses client-side, calls `log_expense` with structured data.
- Under 15 tools total; every optional field has a sane default.

## Conventions

- Code + comments + commits in **English**. No em-dash anywhere (rule).
- Spelling is always **Rteam** (capital R, lowercase team). Never "RTeam".
- Secrets/creds: never in repo. Reference vault `Reference/APIKeys.md`
  (Supabase access token, DB password, MCP login).

## Keys (values in vault, not here)

- MCP login: `myfinance-mcp.com` (legacy `finance.rteam.agency`), user `alex@rteam.top`
- Supabase Management token + Postgres password: vault APIKeys
