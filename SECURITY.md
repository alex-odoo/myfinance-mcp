# Security Policy

MyFinance MCP handles personal financial data, so security reports get priority attention.

## Reporting a vulnerability

Email **alex@rteam.top** with the details. Please include steps to reproduce and the potential impact. You will get a response within 48 hours.

Please do NOT open a public GitHub issue for security problems, and do not test against the hosted instance with other users' data.

## Scope

- This repository (server code, OAuth implementation, statement import, landing).
- The hosted instance at `https://myfinance-mcp.com`.

## What we promise

- Acknowledgement within 48 hours, a fix or mitigation plan within 7 days for confirmed issues.
- Credit in the release notes if you want it.

## Design notes for researchers

- Amounts, merchants and notes are never written to server logs; telemetry stores event types and ids only.
- Receipt images are parsed client-side by the user's AI and never reach the server.
- OAuth 2.1 with PKCE and dynamic client registration; tokens are stored hashed; sign-in is rate limited.
- Row-level data isolation is enforced by `userId` scoping on every query.
