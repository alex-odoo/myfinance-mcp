# Security Policy

MyFinance MCP handles personal financial data, so security reports get priority attention.

## Reporting a vulnerability

Email **alex@a-systems.pro** with the details. Please include steps to reproduce and the potential impact. You will get a response within 48 hours.

Please do NOT open a public GitHub issue for security problems, and do not test against the hosted instance with other users' data.

## Scope

- This repository (server code, OAuth implementation, statement import, landing).
- The hosted instance at `https://myfinance-mcp.com`.

## What we promise

- Acknowledgement within 48 hours, a fix or mitigation plan within 7 days for confirmed issues.
- Credit in the release notes if you want it.

## Design notes for researchers

- Amounts, merchants and notes are never written to server logs; usage events store tool names, timings, error classes and coded argument values (never free text), keyed to the account and deleted with it.
- Receipt images are parsed client-side by the user's AI and never reach the server.
- OAuth 2.1 with PKCE and dynamic client registration; access and refresh tokens (and authorization codes) are opaque random 256-bit values stored only as their SHA-256 hash; access tokens expire after 24 hours; refresh tokens rotate on every use, lapse after 60 days without use and a year after sign-in, and a rotated token presented again after a 30-second grace window revokes the whole sign-in (replay detection); sign-in, including email one-time codes (5 tries, 10 minutes, 3 sends per address per 15 minutes), is rate limited.
- Data isolation is enforced by `userId` scoping on every query; the database's own API is closed (row-level security, deny-all), and the server reaches the database over TLS with a pinned CA.
