# Self-host MyFinance MCP with your own bank

For AI coding agents (Claude Code, Codex, Cursor) setting up a personal MyFinance MCP server for a
person, with their own bank (Revolut or another European bank) synced read-only. Every step says what
you run, what the person does, and how you check it worked. Do the steps in order.

## What the person ends up with

- Their own MyFinance MCP server and database: their records never reach anyone else's server.
- Their bank accounts synced read-only through their OWN Enable Banking application in restricted
  mode. That mode reads only the accounts the person links to the application themselves, and
  Enable Banking allows it, free, for evaluation and individual non-commercial use. It is not a way
  to offer bank sync to other people: that needs a contract with Enable Banking.
- Coverage: the banks Enable Banking lists for the application's countries (European Economic Area;
  Revolut appears as Revolut Bank UAB for EEA customers). Banks outside it (UK unless Enable Banking
  offers it for the application, US, Latin America, Asia) are not reachable this way; for those,
  statement import works without any connection.

## Rules for you, the agent

- Secrets (password hash, TOKEN_ENC_KEY, the Enable Banking private key, DATABASE_URL) go into
  `app.env` only, with `chmod 600`. Never print them, never paste them into the chat, never commit them.
- The person does what needs them: the Enable Banking sign-up and application form, linking their
  accounts, approving at their bank. Tell them exactly what to click and what to send back (only the
  application id). Do not ask for bank passwords: no step needs one.
- Never run `deploy.sh`. It deploys the maintainers' hosted instance (myfinance-mcp.com), not this one.
- After each step, run its check. Stop and report when a check fails; the troubleshooting table below
  maps symptoms to fixes.

## Step 0. Ask the person (one message)

1. Where it runs: a server or always-on machine with a public HTTPS domain (needed for claude.ai and
   ChatGPT connectors and for the bank's redirect back), or only this computer.
2. The database: a Supabase free project, an existing PostgreSQL 15+, or a local Postgres in Docker.
3. The email they will sign in with, and a password for it.
4. Their bank and its country.

## Step 1. Code and database

```bash
git clone https://github.com/alex-odoo/myfinance-mcp.git && cd myfinance-mcp
bun install
DATABASE_URL='<connection string>' bunx prisma db push
# Supabase only: close the tables to Supabase's public Data API
psql '<connection string>' -f prisma/rls.sql
```

Check: `prisma db push` ends with "Your database is now in sync". On Supabase use the session pooler
connection string (IPv4).

## Step 2. app.env

```bash
cp .env.example app.env && chmod 600 app.env
openssl rand -hex 32                                                    # -> TOKEN_ENC_KEY
bun -e "console.log(await Bun.password.hash(process.argv[1]))" '<password>'  # -> MYFINANCE_MCP_PASSWORD_HASH
```

Set in `app.env` (one `KEY=value` per line, no quotes needed):

| Key | Value |
| --- | --- |
| `BASE_URL` | The public HTTPS origin, e.g. `https://finance.example.com` (or `http://localhost:8788` for this computer only) |
| `LEGACY_BASE_URLS` | Keep the line with an EMPTY value (`LEGACY_BASE_URLS=`): left out, it defaults to the maintainers' old domain |
| `DATABASE_URL` | The connection string from step 1 |
| `MYFINANCE_MCP_EMAIL` | The person's sign-in email |
| `MYFINANCE_MCP_PASSWORD_HASH` | The hash printed above |
| `TOKEN_ENC_KEY` | The 64 hex characters printed above |
| `BANK_SYNC_EMAILS` | The same email as `MYFINANCE_MCP_EMAIL`: without it the bank tool is not offered |
| `EB_APP_ID`, `EB_PRIVATE_KEY_B64` | Filled in step 3 |

Everything else in `.env.example` is optional (Google sign-in, email via Resend, Telegram notices).

## Step 3. The Enable Banking application

3a. You generate the key pair (keep the private key out of the repository):

```bash
mkdir -p ~/.myfinance-eb && cd ~/.myfinance-eb
openssl req -x509 -newkey rsa:4096 -nodes -days 3650 -subj "/CN=myfinance" \
  -keyout private.key -out public.crt && chmod 600 private.key
```

3b. The person, in the Enable Banking Control Panel (sign up at enablebanking.com; guide:
https://enablebanking.com/docs/api/control-panel/):

- Register a new application in the **Production** environment.
- Redirect URL: exactly `<BASE_URL>/connect/enablebanking/callback`.
- Key: choose to provide your own certificate and paste the contents of `public.crt` (you show it to
  them; it is the public half, safe to share).
- Send you the application id.

3c. You put it into `app.env`:

```bash
EB_APP_ID=<application id>
EB_PRIVATE_KEY_B64=<output of: base64 < ~/.myfinance-eb/private.key | tr -d '\n'>
```

3d. The person activates the application by linking their own accounts ("Activate by linking
accounts" in the Control Panel, then approve in the bank's app). Until then the application is
inactive; afterwards only the linked accounts can be read. Guide:
https://enablebanking.com/docs/api/linked-accounts/

## Step 4. Run

```bash
docker compose up -d --build        # reads app.env; listens on 127.0.0.1:8788
curl -s http://127.0.0.1:8788/health  # -> {"ok":true,...}
```

For a public domain, put a TLS proxy in front (nginx, Caddy or a Cloudflare Tunnel) that passes every
path to `127.0.0.1:8788`, including `/mcp`, `/authorize`, `/token`, `/register`, `/revoke`, `/.well-known/`
and `/connect/`. Check from outside:

```bash
curl -s <BASE_URL>/health
curl -s -o /dev/null -w '%{http_code}\n' <BASE_URL>/.well-known/oauth-authorization-server   # -> 200
```

## Step 5. Connect the person's AI client

The server is a remote MCP server at `<BASE_URL>/mcp` (Streamable HTTP, OAuth with dynamic client
registration). The client opens a browser sign-in; the person signs in with their email and password.

- Claude Code: `claude mcp add --transport http myfinance <BASE_URL>/mcp`
- claude.ai, ChatGPT, Codex, Cursor: follow https://myfinance-mcp.com/install/ for that client and use
  `<BASE_URL>/mcp` in place of the hosted URL.

Check: ask the AI "which MyFinance account is connected?"; it answers with the person's email
(get_settings).

## Step 6. Connect the bank, in the chat

The person tells their AI: "connect my Revolut" (or their bank). The AI calls the `bank` tool: it finds
the bank, starts the consent and gives a link; the person approves in the bank's app; the browser lands
on a confirmation page; the first sync follows ("sync my bank" runs one at once).

Check: get_accounts lists the bank's accounts and get_transactions shows recent rows. From then on the
server syncs every hour for links older than 20 hours (`AUTO_SYNC_INTERVAL_MS`).

The bank's consent lasts as long as the bank allows (Revolut: 180 days). In its last 7 days the read
tools carry a `bank_notice`, and the person renews from the chat with the same request; no disconnect.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| The server exits: `MYFINANCE_MCP_EMAIL and MYFINANCE_MCP_PASSWORD_HASH are required` | `app.env` incomplete | Fill both, `docker compose up -d` |
| No `bank` tool in the AI client | `BANK_SYNC_EMAILS` lacks the sign-in email, or `EB_APP_ID` / `EB_PRIVATE_KEY_B64` / `TOKEN_ENC_KEY` unset | Fix `app.env`, `docker compose up -d`, then reconnect the client (clients cache the tool list) |
| The bank is approved but no accounts arrive ("No accounts were shared") | The accounts are not linked to the Enable Banking application (restricted mode) | Step 3d |
| The bank is not found | Its country is not among the application's countries, or Enable Banking does not list it | Check the countries in the Control Panel; otherwise use statement import |
| After approving at the bank: an error or 404 | The redirect URL differs from `<BASE_URL>/connect/enablebanking/callback`, or the proxy does not pass `/connect/` | Make them identical; pass every path to the app |
| The AI client cannot connect or sign in | `BASE_URL` is not the exact public origin, or the proxy drops `/.well-known/` or `/register` | Fix `BASE_URL`, restart, check step 4 again |

## Updating

```bash
git pull
DATABASE_URL='<connection string>' bunx prisma db push   # then prisma/rls.sql again on Supabase
docker compose up -d --build
```
