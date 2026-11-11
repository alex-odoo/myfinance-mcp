# AGENTS.md - MyFinance MCP

Two kinds of agent open this repository. Find which one you are first.

## Setting up a personal instance for someone (self-hosting)

Follow [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) step by step: database, `app.env`, the person's own
Enable Banking application for their bank (Revolut or another European bank), Docker, connecting their
AI client, connecting the bank from the chat. Secrets stay in `app.env` (chmod 600), never in the chat
or a commit. Never run `deploy.sh`: it deploys the maintainers' hosted instance.

## Working on the code (maintainers and contributors)

Read [CLAUDE.md](CLAUDE.md): stack, local dev (`bun run dev`, `bun run e2e` on a LOCAL test database),
design rules and conventions. English in code and commits, no em-dash.
