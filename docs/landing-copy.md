# MyFinance MCP - Landing Skeleton + Copy Draft v1

> Domain: myfinance-mcp.com (purchase pending). Server URL: https://myfinance-mcp.com/mcp
> Pattern source: nutrition-mcp.com teardown 2026-07-14 (full verdict in vault Projects/MyFinanceMCP.md Session Log).
> Posture DECIDED: open source, MIT, free while in beta. No Patreon.
> Site = static, no build step, served by nginx on the same origin as the MCP server (/ = landing, /mcp = server).
> All copy below is final-draft quality but expects one review pass by Alex.

---

## Page map

| URL | Purpose |
|---|---|
| `/` | Main landing |
| `/alternatives` | Hub: "Your finance app doesn't have an MCP server" |
| `/mint-mcp` | Per-competitor SEO page (Mint is dead: biggest search tail) |
| `/ynab-mcp` | Per-competitor SEO page |
| `/monarch-money-mcp` | Per-competitor SEO page |
| `/lunch-money-mcp` | Per-competitor SEO page |
| `/copilot-money-mcp` | Per-competitor SEO page |
| `/actual-budget-mcp` | Per-competitor SEO page (OSS angle: "we are OSS too, zero setup") |
| `/firefly-iii-mcp` | Per-competitor SEO page (OSS angle) |
| `/pocketguard-mcp` | Per-competitor SEO page |
| `/privacy` | Privacy & Terms, finance-grade (longer than Nutrition's) |

Plus: `sitemap.xml`, `robots.txt`, `llms.txt`, OG image, favicon, schema.org markup (SoftwareApplication + FAQPage on `/`, FAQPage on competitor pages).

---

## 1. Header

Nav: How it works · Install · Examples · Security · FAQ · Contact · GitHub
Chip under logo: **Free · Open source · OAuth 2.0**

## 2. Hero

**H1:** Track your money by talking to your AI.

**Sub:** Connect Claude or ChatGPT, then just say what you spent. Expenses, income, budgets and net worth, logged and computed for you, in any currency.

CTAs: **Quick install** (#install) · **See it in action** (#examples)

## 3. Live demo (above the fold, right after hero)

Scripted dialog, rendered as chat. Key asset: REAL MCP Apps dashboard screenshot (budget bars render), not text-only like Nutrition.

> **User:** Spent 24.50 eur on groceries at Lidl
>
> **AI:** Logged: 24.50 EUR, groceries. Here's where you are this month:
> [dashboard render: budget progress bars, SPENT/INCOME/NET tiles]
>
> **User:** How am I doing overall?
>
> **AI:** You've spent 1,340 EUR of your 2,000 EUR monthly budget. Groceries and transport are on track; restaurants is at 92% with 10 days left.

Button: **Message MyFinance...** (#install)

## 4. How it works

**H2:** How it works
**Sub:** Three steps. No app to learn.

1. **Connect once.** Works with any AI client that supports remote MCP servers: Claude, ChatGPT, Cursor and more. No install, no API keys.
2. **Just say what you spent.** Plain language, a receipt photo, or a whole bank statement. Categories, currencies and duplicates handled automatically.
3. **Ask anything.** Monthly summaries, trends, budgets, net worth. Every number is computed in SQL on the server. The AI reads the math, it never guesses it.

## 5. Quick install

**H2:** Quick install
**Sub:** Connect in under a minute

Intro: Works with any MCP client that supports OAuth 2.0 with PKCE. On first connect you create an account; sign in the same way to keep your data.

**Tab 1: Claude** (7 steps, mirror Nutrition's numbering)
1. Open Claude and click Customize
2. Click Connectors
3. Click +, then Add custom connector
4. Name it (example: "MyFinance")
5. Paste `https://myfinance-mcp.com/mcp` into Remote MCP server URL
6. **Leave the OAuth Client ID and Client Secret fields EMPTY** (filling them breaks sign-in; your credentials go on the MyFinance sign-in page instead)
7. Click Add, then Connect and sign in

Note: Works on every Claude plan. The free plan allows one connected MCP server at a time.

**Tab 2: ChatGPT** (Settings -> Apps -> Create app -> URL -> OAuth -> Create -> Sign in; mirror Nutrition's 9 steps)

Note: Works right away and shows up in your iOS and Android apps automatically.

**Tab 3: Other agents**
```json
{
  "mcpServers": {
    "myfinance": {
      "url": "https://myfinance-mcp.com/mcp"
    }
  }
}
```
In Claude Code: `claude mcp add --transport http myfinance https://myfinance-mcp.com/mcp`. Windsurf uses `serverUrl` instead of `url`. Your client handles the OAuth login automatically.

## 6. Onboarding (optional)

**H2:** No setup. Really.
**Sub:** It works the moment you connect.

- Your base currency is taken from your first transaction. Change it anytime: "set my base currency to USD".
- Timezone comes from your conversation. One account is created for you automatically.
- Want more? Add accounts ("create my Revolut account in RON"), set budgets, split personal and business. All optional, all conversational.

## 7. Examples: "Try saying"

**H2:** Try saying
**Sub:** Just talk to it.

1. **"Spent 20 eur on lunch"** -> Logged: 20 EUR, restaurants. You're at 180 of your 300 EUR restaurants budget this month.
2. **[receipt photo]** "Log this" -> Got it: Lidl, 47.20 EUR, groceries. 12 line items saved. Your AI reads the receipt right in the chat; the photo never touches our server.
3. **"Here's my June bank statement"** [CSV/PDF] -> Imported 152 transactions, skipped 3 you'd already logged by hand, totals reconciled to the statement. One call, not 152.
4. **"How much did I spend on restaurants in June?"** -> 412 EUR across 18 visits, 14% of your June spending, up 6% from May. [summary render]
5. **"Set a 400 eur monthly budget for groceries"** -> Done. You're at 310 EUR this month, 78% with 9 days left. [budget render]
6. **"That dinner on the business card was personal"** -> Reclassified: entity set to personal. Your business cash-flow report stays clean.
7. **"What's my net worth?"** -> 24,300 EUR across 5 accounts in 3 currencies, converted at today's rates. [accounts render]

Button: **Message MyFinance...**

## 8. Stats strip

**H2:** Logged so far, together
**Sub:** A growing global ledger

Counters (public cached aggregate endpoint, TO BUILD): **transactions logged · currencies · countries**
Deliberately counts only, never amounts.

## 9. Features (8 cards)

**H2:** Everything, just by chatting

1. **Plain-language logging.** Say what you spent or earned; category, currency and date are extracted for you.
2. **Receipt photos.** Snap a receipt; your AI parses it in the chat. Images never reach our server.
3. **Bank statement import.** Drop a CSV or PDF export; hundreds of rows imported in one call, duplicates detected, totals reconciled.
4. **Every currency.** Log in whatever you paid in; summaries answer in your base currency with the exchange rate frozen at transaction date.
5. **Budgets.** Monthly caps per category or overall, with live progress. Alerts only when you actually exceed one.
6. **Summaries and trends.** By category, merchant or month; month-over-month deltas computed server-side.
7. **Personal vs business.** Tag accounts and transactions; a founder's combined view with a clean business cash-flow cut for your accountant.
8. **Export and own your data.** Full CSV export anytime; delete your account and everything with it, instantly.

## 10. Comparison

**H2:** Why MyFinance MCP
**Sub:** Talking beats spreadsheets.

**The old way:**
- The spreadsheet you stopped updating in March
- Budget app #4, another account, another subscription
- Typing every coffee into a form
- One currency, wrong totals

**MyFinance MCP:**
- Say it, snap it, or import the statement
- Works inside Claude or ChatGPT, free
- Math in SQL, never AI guessing
- Any currency, honest totals

Link: Switching from a specific app? See how MyFinance MCP compares to [Mint, YNAB and other trackers](/alternatives).

## 11. Security (full section, not badges: finance-grade trust)

**H2:** Built like your money depends on it

- **Receipts never leave the chat.** Your AI parses photos client-side; the server receives structured numbers only. There is no image storage to breach.
- **EU data residency.** Postgres hosted in the EU with row-level security keyed to your account.
- **Blind logs.** Amounts, merchants and notes are never written to server logs. Telemetry stores event types and ids only.
- **OAuth 2.0 + PKCE.** Standard authorization, encrypted tokens, rate-limited sign-in.
- **Open source (MIT).** Read the code, audit it, or self-host with your own database.
- **GDPR by construction.** CSV export (portability) and instant full deletion (erasure) are tools, not support tickets.

## 12. Beta note (replaces Nutrition's Patreon section)

**H2:** Free while in beta

MyFinance MCP is free during beta, no ads, no card required. Built and run by [Rteam](https://rteam.agency).

## 13. Final CTA

**H2:** Start tracking in under a minute.
**Sub:** Free and open source. It works with the AI you already use.

CTAs: **Quick install** · **Star on GitHub**

## 14. Contact

**H2:** Contact
**Sub:** Questions or feedback?

Found a bug, want a feature, or just have a question? Email me directly. I read every message.
Email: TODO decide (hello@myfinance-mcp.com alias vs alex@rteam.top). Obfuscate on page.

## 15. FAQ (schema.org FAQPage)

1. **What is MyFinance MCP?** A free Model Context Protocol server that lets you track expenses, income, budgets and net worth through natural conversation with Claude or ChatGPT. You tell your AI what you spent; it logs everything and the server does the math.
2. **What is the Model Context Protocol (MCP)?** An open standard that lets AI assistants connect to external tools. An MCP server provides specific capabilities, here personal finance tracking, that the AI can use during a conversation. Think of it as a plugin system for AI assistants.
3. **Does it work with ChatGPT?** Yes. Settings -> Apps -> create a custom app with the server URL using OAuth. Works on every ChatGPT plan.
4. **Which clients are supported?** Any MCP client with OAuth 2.0 + PKCE: Claude.ai, Claude desktop and mobile, Claude Code, Cursor, Windsurf, VS Code.
5. **Is it free?** Yes, free while in beta. No ads, no card.
6. **Is my data private?** Your data is linked to your account and only you can access it. EU hosting, no third-party sharing, no amounts in logs, and you can export or delete everything at any time.
7. **Can it read my bank account?** Not directly, by design. You log by voice/text, receipt photos or statement exports; nothing connects to your bank credentials. Direct bank sync via licensed providers is on the roadmap.
8. **What about duplicates when I import a statement?** The importer detects rows you already logged by hand and merges them instead of duplicating, and re-importing the same statement is safe: already-imported rows are skipped and reported.
9. **Can I split personal and business?** Yes. Accounts and individual transactions carry a personal/business tag; every report can be filtered by it, and the CSV export includes it for your accountant.
10. **Can I self-host it?** Yes. MIT-licensed, runs from a Dockerfile with your own Postgres (Supabase works). The GitHub repository includes a self-hosting guide.

## 16. Footer

MyFinance MCP (/) · Alternatives · How it's built (blog post, post-launch) · Demo (video, post-launch) · GitHub · Contact · Privacy & Terms
Line: Open source under MIT. Built by Rteam.

---

## Per-competitor page template (finance version of Nutrition's)

H1: "Looking for a {Name} MCP server?"
1. **The short answer:** No, {Name} has no MCP server. One paragraph on what MCP is.
2. **What you get instead:** 6 cards (conversational logging, receipt photos, statement import, budgets, multi-currency, export/OSS).
3. **Comparison table:** MCP availability, logging method, pricing, data ownership, open source.
4. **Angle per competitor:**
   - Mint: shut down; "your Mint data has nowhere to live? Import the CSV export in one message."
   - YNAB: price increases; envelope discipline vs zero-setup conversation.
   - Monarch / Copilot: subscription apps; free + open source angle.
   - Lunch Money: respectful tone (indie, API-friendly); angle = inside your AI, no separate app.
   - Actual Budget / Firefly III: "we are open source too, without the self-host setup" (and self-hosting stays possible).
   - PocketGuard: freemium walls vs everything free.
5. **Install (4 steps, Claude-focused)** + link to full guide.
6. **FAQ (5-6 items)** + trademark disclaimer + independence statement.

---

## Open-source pre-flight (before flipping repo public)

1. Secret scan over FULL git history (gitleaks or trufflehog), not just HEAD. Verify .env never committed, argon2/Supabase/OAuth secrets absent.
2. Sanitize internal references: server hostnames/paths in deploy.sh and docs (IP is in public DNS anyway, but review), remove anything vault-specific.
3. README rewrite for public: quickstart, self-host guide (Supabase + Docker), env var table, connector setup with the empty-Client-ID gotcha.
4. SECURITY.md with responsible disclosure contact (finance product, must have).
5. LICENSE: MIT, Rteam FZE LLC (added 2026-07-14).
6. CI already lint+build only, no deploy secrets in workflows: verify.
7. Branch protection on main, issues enabled.
8. CyberSecurity.md checklist pass (CLAUDE.md rule 12) for "repo goes public" + new-domain when myfinance-mcp.com lands.

## Site build notes

- Static HTML/CSS, no framework, no build step (TarotCarousel discipline). One page, one CSS file, tabs and FAQ accordion in vanilla JS.
- Served by nginx on the same origin: `/` static root, `/mcp` proxied to the container. Same vhost as the MCP server, so the landing inherits TLS/HSTS.
- Dashboard screenshots: reuse the real MCP Apps renders from the 0.6.x visual check (light + dark).
- OG image + schema.org SoftwareApplication/FAQPage + sitemap + robots + llms.txt.
- Post-launch distribution: demo video (YouTube short), origin-story post on rteam.agency blog, listings in MCP directories (Anthropic connectors directory, mcp.so, Smithery, PulseMCP, Glama).
