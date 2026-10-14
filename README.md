# MyFinance MCP

A remote MCP server for personal finance, an AI expense tracker for Claude, ChatGPT, Codex and Cursor - log expenses by talking, snap receipt photos, import statements from any bank (CSV, PDF or a screenshot), and get budgets, trends and net worth computed for you, in 150+ currencies.

**Website:** [myfinance-mcp.com](https://myfinance-mcp.com) · Free while in beta · Built by [Rteam](https://rteam.agency)

## Quick Start

Already hosted and ready to use - just connect it to your MCP client:

```
https://myfinance-mcp.com/mcp
```

**On Claude:** Customize → Connectors → **+ Add** → Add custom connector → name it and paste the URL → Continue → Authentication: Sign in now, OAuth client: **Register automatically** → Add. Never choose "Use your own OAuth client" or fill a Client ID/Secret - that breaks sign-in. Works on every Claude plan (Free allows one custom connector).

**On ChatGPT (web):** turn on Developer mode (Settings → Apps → Advanced settings), then Plugins → **+** → Add custom MCP server (older menu: Settings → Apps → Create) → paste the URL → OAuth, client ID/secret empty → create and sign in → type `@` in a chat to use it. Per OpenAI's help center, custom MCP servers with write actions (needed for logging) are available on Business, Enterprise and Edu; Pro gets read-only access; Free, Go and Plus cannot add them, so use Codex there.

**On Cursor:** [Add to Cursor](https://cursor.com/install-mcp?name=MyFinance&config=eyJ1cmwiOiJodHRwczovL215ZmluYW5jZS1tY3AuY29tL21jcCJ9), or add `"myfinance": { "url": "https://myfinance-mcp.com/mcp" }` under `mcpServers` in `~/.cursor/mcp.json`, then click Connect next to MyFinance in Customize.

**On Codex** (included in every ChatGPT plan, Free too):

```bash
codex mcp add myfinance --url https://myfinance-mcp.com/mcp
codex mcp login myfinance
```

On first connect you sign in with Google or with a one-time code sent to your email; that first sign-in creates your MyFinance account. Your data persists across reconnections. Step-by-step guides per client: [myfinance-mcp.com/install](https://myfinance-mcp.com/install).

## Why

- **No app, no forms, no spreadsheet.** "Spent 24.50 eur on groceries at Lidl" is the whole workflow.
- **Every number is computed in SQL.** The server owns the data and the math; the AI reads the results, it never guesses arithmetic.
- **150+ currencies.** Transactions keep their original currency (ECB and National Bank of Ukraine rates, plus a public daily snapshot for every other ISO currency from March 2024); the FX rate to your base currency is frozen at transaction date, so history never rewrites itself.
- **Any bank, by statement.** Drop a CSV/PDF export or a screenshot from your banking app; hundreds of rows import in one call with idempotent deduplication, hand-logged twins merged, totals reconciled. ZenMoney users can sync read-only instead.
- **Personal vs business.** Entity tag on accounts and transactions, filterable everywhere, included in CSV export for your accountant.
- **Dashboards in the chat.** Budgets, trends, summaries and accounts render as interactive panels (MCP Apps) right in the conversation.

## Tech Stack

- **Bun** - runtime and package manager
- **Express** - HTTP layer
- **MCP SDK** - Model Context Protocol over Streamable HTTP (stateless)
- **OAuth 2.1** - PKCE, dynamic client registration and client ID metadata documents (Claude's published identity); sign-in with Google or an emailed one-time code (each optional)
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
| `update_account`      | Rename an account or change its type, entity or main currency                                      |
| `delete_account`      | Delete one money account (with its transactions after explicit confirmation)                       |
| `merge_accounts`      | Fold one account into another: move rows, de-duplicate both sides, rewrite transfers               |
| `get_accounts`        | All accounts with balances and net worth, converted to base currency                               |
| `get_summary`         | Period totals by category, merchant or month; expense or income breakdown, category drill-down and exclusions |
| `get_transactions`    | List and filter transactions, paged (total, has_more, offset)                                      |
| `get_trends`          | Month-over-month spending trends and deltas                                                        |
| `set_budget`          | Monthly cap per category or overall; a log or import that crosses it says so                       |
| `get_budget_progress` | Live budget progress with days left; renders as a dashboard                                        |
| `update_transaction`  | Fix any field of an existing transaction, including its type (e.g. turn a cash withdrawal into a transfer) or its account; category fixes are remembered per merchant for future syncs |
| `delete_transaction`  | Delete one transaction by id                                                                       |
| `delete_transactions` | Bulk delete by ids                                                                                 |
| `get_settings`        | Base currency and timezone                                                                         |
| `update_settings`     | Change base currency or timezone                                                                   |
| `export_transactions` | CSV export, 2000 rows per page: account, transfer counterpart, entity and receipt items on every row |
| `export_profile`      | Everything but the transactions as JSON: settings, accounts with balance history, budgets, merchant rules, bank links |
| `connect_bank`        | _Closed beta, invited accounts only._ Link a real bank via open banking (Enable Banking, EU/UK): list banks, start consent, status, per-account sync toggle, disconnect |
| `sync_bank`           | _Closed beta, invited accounts only._ Pull booked transactions and balances from the connected bank; incremental, transfer pairing, dedup-safe. Healthy connections also auto-sync server-side roughly daily |
| `connect_zenmoney`    | Link a ZenMoney account (international and .ru backends auto-detected) for read-only sync          |
| `sync_zenmoney`       | Pull ZenMoney accounts and transactions; incremental, dedup-safe, keeps your manual edits          |
| `delete_all_data`     | Permanently delete the user profile and ALL data (GDPR erasure)                                    |
| `ping`                | Health and auth check                                                                              |

## MCP Apps

Four tools return an interactive dashboard (`ui://myfinancemcp/dashboard`) rendered directly in the chat on clients that support MCP Apps: budget rings, monthly trends, category summaries and the accounts/net-worth panel. Light and dark theme aware.

## Security & Privacy

- Receipt photos are parsed by YOUR AI client; images never reach this server.
- Amounts, merchants and notes are never written to server logs (blind logs); usage events keep tool names, timings, error classes and coded argument values, keyed to the account and deleted with it.
- OAuth 2.1 with PKCE, rotating refresh tokens (`offline_access` advertised), rate-limited sign-in.
- All 28 tools carry MCP annotations (read-only and destructive ops flagged, connector tools marked open-world), so clients can gate confirmations correctly.
- Bank access is strictly read-only: ZenMoney via the user's own API token, and, in the closed beta, open banking consent via Enable Banking (the bank authenticates the user; we never see credentials). Session ids and tokens are stored AES-256-GCM encrypted.
- CSV export and instant full deletion are tools, not support tickets.
- Hosted instance: EU data residency (Supabase, eu-central-1), TLS to the database with a pinned CA. Every query is scoped to your account by the server; the database's own API is closed to everyone (row-level security, deny-all).
- 206 automated end-to-end checks (full OAuth flow for public and confidential clients incl. browser binding and audience checks, every tool, import dedup semantics, GDPR deletion) run as a hard deploy gate; CI runs lint and typecheck on every push.

See [SECURITY.md](SECURITY.md) for the disclosure policy.

## Self-hosting

MIT-licensed; runs anywhere Bun and Postgres run.

The landing page in `site/` is set in [Switzer](https://www.fontshare.com/fonts/switzer), whose free licence does not allow redistribution, so the font file is not in this repository. For the same look, download it from Fontshare and put `Switzer-Variable.woff2` in `site/fonts/`; without it the pages fall back to the system font. The MCP server does not need it.

### 1. Postgres

Any PostgreSQL 15+ works. [Supabase](https://supabase.com) free tier is a good fit: create a project and copy the **session pooler** connection string (IPv4).

Apply the schema, then close the tables to Supabase's public Data API (Prisma creates tables with row-level security OFF, and Supabase exposes every public table to anyone holding the project's anon key). Re-run the second command after every `db push` that adds a table:

```bash
bun install
bunx prisma db push
psql "$DATABASE_URL" -f prisma/rls.sql
```

Database TLS: Supabase hosts are verified against Supabase's root CA automatically; for any other host, put `sslmode=` in `DATABASE_URL`.

### 2. Environment variables

| Variable                      | Description                                                        |
| ----------------------------- | ------------------------------------------------------------------ |
| `PORT`                        | Server port (default `8788`)                                       |
| `BASE_URL`                    | Public URL of the server (OAuth issuer)                            |
| `LEGACY_BASE_URLS`            | _(optional)_ Older public origins served by the same container, comma-separated; tokens bound to them stay valid and their `/authorize` redirects to `BASE_URL` |
| `DATABASE_URL`                | Postgres connection string                                         |
| `MYFINANCE_MCP_EMAIL`         | Bootstrap user email                                               |
| `MYFINANCE_MCP_PASSWORD_HASH` | Bootstrap user password hash (see below)                           |
| `GOOGLE_CLIENT_ID`            | _(optional)_ Google OAuth client ID for "Continue with Google"     |
| `GOOGLE_CLIENT_SECRET`        | _(optional)_ Google OAuth client secret                            |
| `RESEND_API_KEY`              | _(optional)_ Resend key: email sign-in codes and signup notifications |
| `NOTIFY_EMAIL`                | _(optional)_ Where signup notifications go                         |
| `FROM_EMAIL`                  | _(optional)_ Verified sender; with `RESEND_API_KEY` it turns on email sign-in |
| `TELEGRAM_BOT_TOKEN`          | _(optional)_ Telegram bot for new-signup notifications             |
| `TELEGRAM_CHAT_ID`            | _(optional)_ Chat that receives them                               |
| `TOKEN_ENC_KEY`               | Required for ZenMoney and bank connections: 64 hex chars (`openssl rand -hex 32`), encrypts stored provider tokens |
| `EB_APP_ID`                   | _(optional)_ Enable Banking application id; bank connections stay off until it and the key are set |
| `EB_PRIVATE_KEY_B64`          | _(optional)_ Base64 of the Enable Banking application's private key PEM |
| `EB_API_ORIGIN`               | _(optional)_ Enable Banking API origin, default `https://api.enablebanking.com` |
| `REFRESH_REUSE_GRACE_MS`      | _(optional)_ How long a rotated refresh token keeps working, default `30000` (parallel refreshes) |
| `AUTO_SYNC_INTERVAL_MS`       | _(optional)_ Bank auto-sync tick, default hourly (syncs connections >20h stale); `0` disables |

Generate the password hash:

```bash
bun -e "console.log(await Bun.password.hash(process.argv[1]))" 'your-password'
```

### 3. Run

```bash
cp .env.example app.env   # docker compose reads app.env, not .env
docker compose up -d      # uses the included Dockerfile, port 8788
```

Put nginx (or any TLS-terminating proxy) in front and point `BASE_URL` at your domain. The static landing in [`site/`](site/) is optional - serve it from the same origin if you want one.

## Development

```bash
bun install
cp .env.example .env   # fill in your values
bun run dev            # hot reload on :8788
bun run e2e            # end-to-end suite (spawns its own server; WRITES to the DATABASE_URL database)
bun run lint
```

The e2e suite (346 checks) covers the full OAuth flow (discovery, dynamic registration, client ID metadata documents, PKCE, refresh rotation, revocation; public and confidential clients), every tool, statement-import dedup semantics, ZenMoney sync against a stubbed Diff API, and GDPR deletion.

## API Endpoints

| Endpoint                                       | Description                              |
| ---------------------------------------------- | ---------------------------------------- |
| `POST /mcp`                                    | MCP endpoint (Bearer auth)               |
| `GET /health`                                  | Health check                             |
| `GET /.well-known/oauth-authorization-server`  | OAuth metadata discovery                 |
| `GET /.well-known/oauth-protected-resource/mcp`| Protected resource metadata              |
| `POST /register`                               | Dynamic client registration (clients may instead use an https client_id: a client ID metadata document) |
| `GET /authorize`                               | OAuth authorization (sign-in page)       |
| `POST /token`                                  | Token exchange                           |
| `GET /auth/google`                             | Google sign-in start (when configured)   |
| `POST /login/email`, `POST /login/email/verify`| Email sign-in code: send, verify (when configured) |
| `GET /connect/enablebanking/callback`, `POST /connect/enablebanking/confirm` | Bank consent return and the confirm step |
| `GET /api/stats`                               | Public aggregate counters (counts only, never amounts) |

## License

[MIT](LICENSE) - Rteam FZE LLC
