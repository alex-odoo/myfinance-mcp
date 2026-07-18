# MyFinance MCP

A remote MCP server for personal finance - log expenses by talking, snap receipt photos, import whole bank statements, and get budgets, trends and net worth computed for you, in any currency.

**Website:** [myfinance-mcp.com](https://myfinance-mcp.com) · Free while in beta · Built by [Rteam](https://rteam.agency)

## Quick Start

Already hosted and ready to use - just connect it to your MCP client:

```
https://myfinance-mcp.com/mcp
```

**On Claude.ai:** Customize → Connectors → **+** → Add custom connector → paste the URL → Connect. Leave the OAuth Client ID and Client Secret fields **empty** - filling them breaks sign-in.

**On ChatGPT:** Settings → Apps → Create app → paste the URL → choose OAuth → Create.

On first connect you sign in with Google or register with an email and password. Your data persists across reconnections.

## Why

- **No app, no forms, no spreadsheet.** "Spent 24.50 eur on groceries at Lidl" is the whole workflow.
- **Every number is computed in SQL.** The server owns the data and the math; the AI reads the results, it never guesses arithmetic.
- **Any currency.** Transactions keep their original currency; the FX rate to your base currency is frozen at transaction date, so history never rewrites itself.
- **Statements in one message.** Drop a CSV/PDF export; hundreds of rows import in one call with idempotent deduplication, hand-logged twins merged, totals reconciled.
- **Personal vs business.** Entity tag on accounts and transactions, filterable everywhere, included in CSV export for your accountant.
- **Dashboards in the chat.** Budgets, trends, summaries and accounts render as interactive panels (MCP Apps) right in the conversation.

## Tech Stack

- **Bun** - runtime and package manager
- **Express** - HTTP layer
- **MCP SDK** - Model Context Protocol over Streamable HTTP (stateless)
- **OAuth 2.1** - PKCE + dynamic client registration, Google sign-in optional
- **Prisma + PostgreSQL** - all money as `numeric`, all stats as SQL aggregates
- **Docker** - single container deployment

## MCP Tools

| Tool                  | Description                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `log_expense`         | Record one purchase, bill or receipt (negative amount = refund)                                    |
| `log_income`          | Record income: salary, invoice, refund, interest                                                   |
| `log_transfer`        | Move money between accounts, cross-currency supported; never counts as spending                    |
| `log_balance`         | Anchor an account's balance at a date; later flows compute from the snapshot                       |
| `import_transactions` | Bulk statement import (up to 500 rows/call): dedup by bank reference or derived key, twin merge, reconciliation check |
| `create_account`      | Create a bank / card / cash / investment account with currency and personal/business entity        |
| `get_accounts`        | All accounts with balances and net worth, converted to base currency                               |
| `get_summary`         | Period totals by category, merchant or month; expense or income breakdown, category drill-down and exclusions |
| `get_transactions`    | List and filter raw transactions                                                                   |
| `get_trends`          | Month-over-month spending trends and deltas                                                        |
| `set_budget`          | Monthly cap per category or overall                                                                |
| `get_budget_progress` | Live budget progress with days left; renders as a dashboard                                        |
| `update_transaction`  | Fix any field of an existing transaction                                                           |
| `delete_transaction`  | Delete one transaction by id                                                                       |
| `delete_transactions` | Bulk delete by ids                                                                                 |
| `get_settings`        | Base currency and timezone                                                                         |
| `update_settings`     | Change base currency or timezone                                                                   |
| `export_transactions` | Full CSV export (includes the entity column for accountant handoff)                                |
| `delete_account`      | Permanently delete the user account and ALL data (GDPR erasure)                                    |
| `ping`                | Health and auth check                                                                              |

## MCP Apps

Four tools return an interactive dashboard (`ui://myfinancemcp/dashboard`) rendered directly in the chat on clients that support MCP Apps: budget rings, monthly trends, category summaries and the accounts/net-worth panel. Light and dark theme aware.

## Security & Privacy

- Receipt photos are parsed by YOUR AI client; images never reach this server.
- Amounts, merchants and notes are never written to server logs (blind logs); telemetry stores event types and ids only.
- OAuth 2.1 with PKCE, encrypted tokens, rate-limited sign-in.
- CSV export and instant full deletion are tools, not support tickets.
- Hosted instance: EU data residency, row-level security keyed to your account.

See [SECURITY.md](SECURITY.md) for the disclosure policy.

## Self-hosting

MIT-licensed; runs anywhere Bun and Postgres run.

### 1. Postgres

Any PostgreSQL 15+ works. [Supabase](https://supabase.com) free tier is a good fit: create a project and copy the **session pooler** connection string (IPv4).

Apply the schema:

```bash
bun install
bunx prisma db push
```

### 2. Environment variables

| Variable                      | Description                                                        |
| ----------------------------- | ------------------------------------------------------------------ |
| `PORT`                        | Server port (default `8788`)                                       |
| `BASE_URL`                    | Public URL of the server (OAuth issuer)                            |
| `DATABASE_URL`                | Postgres connection string                                         |
| `MYFINANCE_MCP_EMAIL`         | Bootstrap user email                                               |
| `MYFINANCE_MCP_PASSWORD_HASH` | Bootstrap user password hash (see below)                           |
| `GOOGLE_CLIENT_ID`            | _(optional)_ Google OAuth client ID for "Continue with Google"     |
| `GOOGLE_CLIENT_SECRET`        | _(optional)_ Google OAuth client secret                            |
| `RESEND_API_KEY`              | _(optional)_ Resend key for new-signup email notifications         |
| `NOTIFY_EMAIL`                | _(optional)_ Where signup notifications go                         |
| `FROM_EMAIL`                  | _(optional)_ Verified sender for notifications                     |

Generate the password hash:

```bash
bun -e "console.log(await Bun.password.hash(process.argv[1]))" 'your-password'
```

### 3. Run

```bash
docker compose up -d      # uses the included Dockerfile, port 8788
```

Put nginx (or any TLS-terminating proxy) in front and point `BASE_URL` at your domain. The static landing in [`site/`](site/) is optional - serve it from the same origin if you want one.

## Development

```bash
bun install
cp .env.example .env   # fill in your values
bun run dev            # hot reload on :8788
bun run e2e            # self-contained end-to-end suite (spawns its own server)
bun run lint
```

The e2e suite covers the full OAuth flow (discovery, dynamic registration, PKCE, refresh rotation), every tool, statement-import dedup semantics and GDPR deletion.

## API Endpoints

| Endpoint                                       | Description                              |
| ---------------------------------------------- | ---------------------------------------- |
| `POST /mcp`                                    | MCP endpoint (Bearer auth)               |
| `GET /health`                                  | Health check                             |
| `GET /.well-known/oauth-authorization-server`  | OAuth metadata discovery                 |
| `GET /.well-known/oauth-protected-resource/mcp`| Protected resource metadata              |
| `POST /register`                               | Dynamic client registration              |
| `GET /authorize`                               | OAuth authorization (sign-in page)       |
| `POST /token`                                  | Token exchange                           |
| `GET /auth/google`                             | Google sign-in start (when configured)   |
| `GET /api/stats`                               | Public aggregate counters (counts only, never amounts) |

## License

[MIT](LICENSE) - Rteam FZE LLC
