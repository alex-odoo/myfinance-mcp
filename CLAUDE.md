# CLAUDE.md - MyFinance MCP

> Guidance for AI coding agents working in this repo.

## What it is

Personal finance tracking through a **remote MCP server**. The user's own AI
client (Claude, ChatGPT, Cursor) is the UI: log expenses by voice or receipt
photo, ask for stats in plain language. No app, no forms. The server owns the
DATA and the MATH; the AI client owns the ADVICE.

## Stack

- **Bun + TypeScript** + `@modelcontextprotocol/sdk` (Streamable HTTP, stateless) + Express
- **OAuth 2.1** - PKCE + dynamic client registration
- **Prisma + Postgres** (hosted instance: Supabase, eu-central-1)
- **Docker** behind nginx
- Hosted instance: `https://myfinance-mcp.com` (MCP endpoint `POST /mcp`, Bearer token)

## Deploy (maintainer only - never manual)

```bash
./deploy.sh "what changed"
```

One-way Mac -> server: local `bun run build` + `bun run e2e` gate, commit +
push `main`, rsync, `docker compose build && up -d`, nginx sync, health check.
**Never edit code on the box.** Secrets live in `app.env` on the server
(chmod 600) - not in repo, not rsynced.

## Local dev

```bash
bun install
cp .env.example .env   # fill in your values
bun run dev            # server on :8788
bun run e2e            # self-contained E2E proof
bun run e2e https://myfinance-mcp.com      # same suite vs prod (E2E_EMAIL/E2E_PASSWORD)
bun run lint
```

Password hash: `bun -e "console.log(await Bun.password.hash(process.argv[1]))" 'pw'`

## Database

Schema changes go through `prisma db push`. After any push that adds a table,
re-run `psql "$DATABASE_URL" -f prisma/rls.sql` - Prisma creates tables with
RLS off, and a public-schema table without RLS is exposed through the Supabase
Data API to anyone with the anon key (see the header of that file).

## Design rules (simplicity contract)

- **Zero setup, no forms, no category picking.** Natural language / photo IS the input; category is a fixed enum the server enforces.
- **Money = `numeric`, never float.** All statistics are SQL aggregates over `amount_base`; the LLM never does arithmetic over raw records.
- **Multi-currency invisible:** store original amount + currency + fx rate frozen at log time; summaries answer in base currency.
- **Silence over noise.** Budget alerts only when a budget exists and is exceeded.
- **Receipt photos never reach the server** - the AI client parses them client-side, calls `log_expense` with structured data.
- Every optional field has a sane default.

## Conventions

- Code + comments + commits in **English**. No em-dash anywhere - use a hyphen.
- Spelling is always **Rteam** (capital R, lowercase team). Never "RTeam".
- Secrets/creds: never in repo, never in logs. Amounts and merchants never
  appear in server logs either (blind-logs rule, see SECURITY.md).
