/**
 * Gate A end-to-end proof, self-contained:
 * spawns the server with test credentials, then walks the exact path a
 * Claude.ai custom connector takes: metadata discovery -> dynamic client
 * registration -> authorize (login form) -> PKCE code exchange -> MCP
 * initialize/tools/ping -> refresh -> negative cases.
 *
 * Usage: bun run scripts/gate-a-e2e.ts [baseUrl]
 * With baseUrl argument it tests a running (e.g. production) server instead
 * of spawning one; set E2E_EMAIL/E2E_PASSWORD env for that mode.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Subprocess } from "bun";

const externalBase = process.argv[2];
const PORT = 8790;
const BASE = externalBase?.replace(/\/$/, "") ?? `http://localhost:${PORT}`;
const EMAIL = process.env.E2E_EMAIL ?? "gate-a@test.local";
const PASSWORD = process.env.E2E_PASSWORD ?? "gate-a-secret";
const REDIRECT_URI = "http://localhost:19999/callback";

let passed = 0;
function ok(name: string, cond: boolean, detail?: string): void {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` :: ${detail}` : ""}`);
  passed += 1;
  console.log(`  ok ${name}`);
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function round2c(n: number): number {
  return Math.round(n * 100) / 100;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function mcpCall(token: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: res.status === 202 ? null : await res.json() };
}

let serverProc: Subprocess | null = null;
let zenStub: { stop: (closeActiveConnections?: boolean) => void } | null = null;
let ebStub: { stop: (closeActiveConnections?: boolean) => void } | null = null;

const ZEN_PORT = 8791;
const ZEN_TOKEN = "zen-e2e-token-0123456789";
const EB_PORT = 8792;

/**
 * ZenMoney Diff API stub. Phases keyed by the cursor the server sends:
 * 0 -> full fixture; 1000 -> incremental (one changed row + deletions);
 * anything else (incl. the token-validation call with cursor=now) -> empty diff.
 */
function startZenStub() {
  const instruments = [{ id: 3, shortTitle: "EUR" }];
  const accounts = [
    { id: "za-card", title: "Zen Card", type: "ccard", instrument: 3, balance: 900 },
    { id: "za-cash", title: "Zen Cash", type: "cash", instrument: 3, balance: 100 },
    { id: "za-loan", title: "Zen Loan", type: "loan", instrument: 3, balance: -5000 },
    { id: "za-arch", title: "Old Card", type: "ccard", instrument: 3, balance: 0, archive: true },
  ];
  const tags = [
    { id: "zt-food", title: "Продукты" },
    { id: "zt-garage", title: "Гараж" },
    { id: "zt-salary", title: "Зарплата" },
  ];
  const merchants = [{ id: "zm-lidl", title: "Lidl" }];
  const tx = (o: Record<string, unknown>) => ({
    income: 0,
    outcome: 0,
    incomeAccount: null,
    outcomeAccount: null,
    incomeInstrument: null,
    outcomeInstrument: null,
    changed: 900,
    ...o,
  });
  return Bun.serve({
    port: ZEN_PORT,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v8/diff/") return new Response("not found", { status: 404 });
      if (req.headers.get("authorization") !== `Bearer ${ZEN_TOKEN}`)
        return new Response("unauthorized", { status: 401 });
      const body = (await req.json()) as { serverTimestamp: number };
      if (body.serverTimestamp === 0) {
        return Response.json({
          serverTimestamp: 1000,
          instrument: instruments,
          account: accounts,
          tag: tags,
          merchant: merchants,
          transaction: [
            tx({ id: "zt1", date: "2026-07-10", outcome: 50, outcomeAccount: "za-card", outcomeInstrument: 3, tag: ["zt-food"], merchant: "zm-lidl" }),
            tx({ id: "zt2", date: "2026-07-10", outcome: 20, outcomeAccount: "za-card", outcomeInstrument: 3, tag: ["zt-garage"] }),
            tx({ id: "zt3", date: "2026-07-11", income: 1000, incomeAccount: "za-card", incomeInstrument: 3, tag: ["zt-salary"] }),
            tx({ id: "zt4", date: "2026-07-11", outcome: 100, outcomeAccount: "za-card", outcomeInstrument: 3, income: 100, incomeAccount: "za-cash", incomeInstrument: 3 }),
            tx({ id: "zt5", date: "2026-07-12", outcome: 30, outcomeAccount: "za-loan", outcomeInstrument: 3 }),
            tx({ id: "zt6", date: "2026-07-12", outcome: 15, outcomeAccount: "za-card", outcomeInstrument: 3, mcc: 5812, payee: "Trattoria" }),
          ],
        });
      }
      if (body.serverTimestamp === 1000) {
        return Response.json({
          serverTimestamp: 2000,
          instrument: instruments,
          account: accounts,
          tag: tags,
          merchant: merchants,
          transaction: [
            tx({ id: "zt1", date: "2026-07-10", outcome: 55, outcomeAccount: "za-card", outcomeInstrument: 3, tag: ["zt-food"], merchant: "zm-lidl", changed: 1500 }),
          ],
          deletion: [
            { id: "zt2", object: "transaction", stamp: 1500 },
            { id: "zt3", object: "transaction", stamp: 1500 },
          ],
        });
      }
      return Response.json({ serverTimestamp: body.serverTimestamp + 1 });
    },
  });
}

/**
 * Enable Banking API stub. /auth returns a "bank consent" URL that points
 * straight at the server's callback (instant approval); two accounts, paged
 * transactions, one cross-account transfer pair, one pending row.
 */
function startEbStub() {
  const eur = (amount: string) => ({ currency: "EUR", amount });
  return Bun.serve({
    port: EB_PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (!req.headers.get("authorization")?.startsWith("Bearer ")) {
        return new Response("unauthorized", { status: 401 });
      }
      if (url.pathname === "/aspsps") {
        return Response.json({
          aspsps: [{ name: "Mock Bank", country: url.searchParams.get("country") ?? "FI", maximum_consent_validity: 7_776_000 }],
        });
      }
      if (url.pathname === "/auth" && req.method === "POST") {
        const body = (await req.json()) as { state: string; redirect_url: string };
        return Response.json({ url: `${body.redirect_url}?code=e2e-eb-code&state=${body.state}` });
      }
      if (url.pathname === "/sessions" && req.method === "POST") {
        const body = (await req.json()) as { code: string };
        if (body.code !== "e2e-eb-code") return new Response("bad code", { status: 400 });
        return Response.json({
          session_id: "e2e-eb-session",
          aspsp: { name: "Mock Bank", country: "FI" },
          access: { valid_until: new Date(Date.now() + 90 * 86_400_000).toISOString() },
          accounts: [
            { uid: "eb-acc-1", name: "Main Account", currency: "EUR", account_id: { iban: "FI2112345600000785" } },
            { uid: "eb-acc-2", name: "Savings", currency: "EUR", account_id: { iban: "FI2112345600000786" } },
            // Multi-currency sub-account repeating the same display name, like
            // Revolut repeats the holder's name on RON/EUR/USD sub-accounts.
            { uid: "eb-acc-3", name: "Main Account", currency: "RON", account_id: { iban: "FI2112345600000787" } },
          ],
        });
      }
      if (url.pathname === "/accounts/eb-acc-1/transactions") {
        if (url.searchParams.get("continuation_key") === "p2") {
          return Response.json({
            transactions: [
              { entry_reference: "ref-3", transaction_amount: eur("200.00"), credit_debit_indicator: "DBIT", status: "BOOK", booking_date: "2026-07-16", remittance_information: ["Own transfer"] },
              { entry_reference: "ref-4", transaction_amount: eur("15.30"), credit_debit_indicator: "DBIT", status: "BOOK", booking_date: "2026-07-16", creditor: { name: "Cafe X" } },
              { entry_reference: "ref-5", transaction_amount: eur("9.99"), credit_debit_indicator: "DBIT", status: "PDNG", booking_date: "2026-07-17", creditor: { name: "Pending Shop" } },
            ],
          });
        }
        return Response.json({
          transactions: [
            { entry_reference: "ref-1", transaction_amount: eur("12.50"), credit_debit_indicator: "DBIT", status: "BOOK", booking_date: "2026-07-15", creditor: { name: "Lidl Helsinki" }, merchant_category_code: "5411" },
            { entry_reference: "ref-2", transaction_amount: eur("2500.00"), credit_debit_indicator: "CRDT", status: "BOOK", booking_date: "2026-07-14", debtor: { name: "ACME Oy" }, remittance_information: ["Salary July"] },
          ],
          continuation_key: "p2",
        });
      }
      if (url.pathname === "/accounts/eb-acc-2/transactions") {
        return Response.json({
          transactions: [
            { entry_reference: "ref-6", transaction_amount: eur("200.00"), credit_debit_indicator: "CRDT", status: "BOOK", booking_date: "2026-07-16", remittance_information: ["Own transfer"] },
          ],
        });
      }
      if (url.pathname === "/accounts/eb-acc-3/transactions") {
        return Response.json({ transactions: [] });
      }
      if (url.pathname === "/accounts/eb-acc-3/balances") {
        return Response.json({ balances: [{ balance_type: "CLBD", balance_amount: { currency: "RON", amount: "0.00" } }] });
      }
      if (url.pathname === "/accounts/eb-acc-1/balances") {
        return Response.json({ balances: [{ balance_type: "CLBD", balance_amount: eur("3000.55") }] });
      }
      if (url.pathname === "/accounts/eb-acc-2/balances") {
        return Response.json({ balances: [{ balance_type: "CLBD", balance_amount: eur("1200.00") }] });
      }
      if (url.pathname.startsWith("/sessions/") && req.method === "DELETE") {
        return Response.json({ deleted: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

async function main(): Promise<void> {
  if (!externalBase) {
    const { generateKeyPairSync } = await import("node:crypto");
    const ebKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    // The e2e process itself imports src modules (db, autosync); they must see
    // the same stub-pointing env as the spawned server BEFORE the first import,
    // because config.ts snapshots process.env at module load.
    process.env.TOKEN_ENC_KEY = "ab".repeat(32);
    process.env.EB_APP_ID = "e2e-eb-app";
    process.env.EB_PRIVATE_KEY_B64 = Buffer.from(ebKey).toString("base64");
    process.env.EB_API_ORIGIN = `http://localhost:${EB_PORT}`;
    process.env.ZENMONEY_API_BASE = `http://localhost:${ZEN_PORT}`;
    // Idempotency: a previously crashed run may have left the test user behind
    const { db } = await import("../src/db");
    await db.user.deleteMany({ where: { email: EMAIL } });
    const hash = await Bun.password.hash(PASSWORD);
    zenStub = startZenStub();
    ebStub = startEbStub();
    serverProc = Bun.spawn(["bun", "run", "src/index.ts"], {
      env: {
        ...process.env,
        PORT: String(PORT),
        BASE_URL: BASE,
        MYFINANCE_MCP_EMAIL: EMAIL,
        MYFINANCE_MCP_PASSWORD_HASH: hash,
        // Fake Google OAuth client: enables the button + start/callback routes
        // so the redirect and CSRF-state negative paths are testable offline.
        GOOGLE_CLIENT_ID: "e2e-google-client.apps.googleusercontent.com",
        GOOGLE_CLIENT_SECRET: "e2e-google-secret",
        ZENMONEY_API_BASE: `http://localhost:${ZEN_PORT}`,
        TOKEN_ENC_KEY: "ab".repeat(32),
        EB_APP_ID: "e2e-eb-app",
        EB_PRIVATE_KEY_B64: Buffer.from(ebKey).toString("base64"),
        EB_API_ORIGIN: `http://localhost:${EB_PORT}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`${BASE}/health`);
        if (r.ok) break;
      } catch {
        /* not up yet */
      }
      await Bun.sleep(100);
      if (i === 49) throw new Error("server did not start");
    }
  }

  console.log(`Gate A e2e against ${BASE}`);

  // 0. Public landing stats: counts only, never amounts
  const statsRes = await fetch(`${BASE}/api/stats`);
  ok("stats endpoint responds", statsRes.ok);
  const stats: any = await statsRes.json();
  ok(
    "stats shape (counts only)",
    typeof stats.transactions === "number" &&
      typeof stats.currencies === "number" &&
      typeof stats.files === "number" &&
      Array.isArray(stats.timezone_list),
    JSON.stringify(stats).slice(0, 200)
  );

  // 1. Discovery
  const asMeta: any = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  ok("AS metadata", !!asMeta.authorization_endpoint && !!asMeta.token_endpoint);
  ok("PKCE S256 advertised", asMeta.code_challenge_methods_supported?.includes("S256"));
  const prm: any = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  ok("protected resource metadata", prm.resource?.endsWith("/mcp"));
  const prmRoot: any = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
  ok("protected resource metadata (root variant)", prmRoot.resource?.endsWith("/mcp"));

  // 2. Dynamic client registration
  const reg = await fetch(asMeta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Gate A e2e",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const client: any = await reg.json();
  ok("dynamic registration", reg.status === 201 && !!client.client_id, JSON.stringify(client));

  // 3. Authorize -> login form
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const authUrl = new URL(asMeta.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", client.client_id);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", "e2e-state-123");
  const authRes = await fetch(authUrl);
  const authHtml = await authRes.text();
  const requestId = authHtml.match(/name="request_id" value="([^"]+)"/)?.[1];
  ok("authorize renders login form", authRes.status === 200 && !!requestId);

  // 3b. Google sign-in wiring
  if (!externalBase) {
    ok("login page offers Google", authHtml.includes(`/auth/google?request_id=`));
    const gStart = await fetch(`${BASE}/auth/google?request_id=${requestId}`, { redirect: "manual" });
    const gLoc = gStart.headers.get("location") ?? "";
    ok(
      "google start -> 302 to accounts.google.com",
      gStart.status === 302 && gLoc.startsWith("https://accounts.google.com/o/oauth2/v2/auth")
    );
    ok("google start carries state + client_id", /[?&]state=/.test(gLoc) && gLoc.includes("client_id="));
  }
  // Enabled -> 400 (bad request), not configured -> 404; both prove routing works.
  const gBadReq = await fetch(`${BASE}/auth/google?request_id=bogus`, { redirect: "manual" });
  ok("google start with bogus request rejected", gBadReq.status === 400 || gBadReq.status === 404);
  const gBadState = await fetch(`${BASE}/auth/google/callback?state=bogus&code=x`, { redirect: "manual" });
  ok("google callback with bogus state rejected", gBadState.status === 400 || gBadState.status === 404);

  // 4. Wrong password rejected
  const badLogin = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId!, email: EMAIL, password: "wrong" }),
    redirect: "manual",
  });
  ok("wrong password -> 401", badLogin.status === 401);

  // 5. Login -> code
  const login = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId!, email: EMAIL, password: PASSWORD }),
    redirect: "manual",
  });
  const location = login.headers.get("location") ?? "";
  const cbUrl = new URL(location);
  const code = cbUrl.searchParams.get("code");
  ok("login redirects with code", login.status === 302 && !!code);
  ok("state round-trip", cbUrl.searchParams.get("state") === "e2e-state-123");

  // 6. Token exchange with wrong verifier rejected
  const badToken = await fetch(asMeta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      code_verifier: b64url(randomBytes(48)),
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
    }),
  });
  ok("wrong PKCE verifier rejected", badToken.status === 400);

  // 7. Token exchange
  const tokenRes = await fetch(asMeta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
    }),
  });
  const tokens: any = await tokenRes.json();
  ok(
    "code -> tokens",
    tokenRes.status === 200 && !!tokens.access_token && !!tokens.refresh_token,
    JSON.stringify(tokens)
  );

  // 8. Code is single-use
  const replay = await fetch(asMeta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
    }),
  });
  ok("code replay rejected", replay.status === 400);

  // 9. MCP without token -> 401 + WWW-Authenticate
  const noAuth = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 0 }),
  });
  ok("MCP without token -> 401", noAuth.status === 401);
  ok("WWW-Authenticate present", (noAuth.headers.get("www-authenticate") ?? "").includes("resource_metadata"));

  // 10. MCP initialize
  const init = await mcpCall(tokens.access_token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "gate-a-e2e", version: "1.0.0" },
    },
  });
  ok("MCP initialize", init.status === 200 && init.json?.result?.serverInfo?.name === "myfinancemcp", JSON.stringify(init.json));

  // 11. tools/list
  const list = await mcpCall(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolNames = (list.json?.result?.tools ?? []).map((t: any) => t.name);
  ok("tools/list has ping", toolNames.includes("ping"), JSON.stringify(toolNames));

  // 11b. MCP Apps: tool _meta links + UI resource served
  const sumTool = (list.json?.result?.tools ?? []).find((t: any) => t.name === "get_summary");
  ok(
    "get_summary linked to dashboard UI",
    sumTool?._meta?.ui?.resourceUri === "ui://myfinancemcp/dashboard",
    JSON.stringify(sumTool?._meta)
  );
  const uiRes = await mcpCall(tokens.access_token, {
    jsonrpc: "2.0",
    id: 21,
    method: "resources/read",
    params: { uri: "ui://myfinancemcp/dashboard" },
  });
  const uiContent = uiRes.json?.result?.contents?.[0];
  ok(
    "dashboard resource serves HTML",
    uiContent?.mimeType === "text/html;profile=mcp-app" && String(uiContent?.text).includes("ui/notifications/tool-result"),
    JSON.stringify({ mime: uiContent?.mimeType, len: String(uiContent?.text).length })
  );

  // 12. tools/call ping
  const call = await mcpCall(tokens.access_token, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "ping", arguments: {} },
  });
  const pingPayload = JSON.parse(call.json?.result?.content?.[0]?.text ?? "{}");
  ok("ping returns ok", pingPayload.ok === true && pingPayload.user === EMAIL, JSON.stringify(pingPayload));

  // 12b. Finance flow (spawn mode only: creates + wipes a test user; never against prod)
  if (!externalBase) {
    const call = (name: string, args: Record<string, unknown> = {}, id = 100) =>
      mcpCall(tokens.access_token, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const payload = (r: any) => JSON.parse(r.json?.result?.content?.[0]?.text ?? "{}");
    const isErr = (r: any) => r.json?.result?.isError === true;

    const e1 = payload(await call("log_expense", { amount: 250, currency: "UAH", category: "groceries", merchant: "Silpo" }));
    ok("log_expense UAH", e1.id && e1.currency === "UAH" && e1.amount_base > 0 && e1.base_currency === "EUR", JSON.stringify(e1));
    const e2 = payload(await call("log_expense", { amount: 12.5, category: "restaurants", merchant: "Cafe", items: [{ name: "lunch", price: 12.5 }] }));
    ok("log_expense receipt items", e2.id && e2.amount_base === 12.5, JSON.stringify(e2));
    const inc = payload(await call("log_income", { amount: 1000, currency: "USD", category: "freelance" }));
    ok("log_income USD", inc.id && inc.amount_base > 0, JSON.stringify(inc));

    const sum = payload(await call("get_summary", {}));
    ok(
      "get_summary totals",
      sum.total_expense > 0 && sum.total_income > 0 && sum.groups.length === 2 && sum.groups[0].share_pct > 0,
      JSON.stringify(sum)
    );

    const list = payload(await call("get_transactions", { merchant: "silpo" }));
    ok("get_transactions merchant search", list.count === 1 && list.transactions[0].merchant === "Silpo");

    const upd = payload(await call("update_transaction", { id: e1.id, category: "restaurants" }));
    ok("update_transaction recategorize", upd.updated === true && upd.category === "restaurants");

    const sumInc = payload(await call("get_summary", { type: "income" }));
    ok(
      "get_summary income breakdown",
      sumInc.grouped_type === "income" &&
        sumInc.groups.length === 1 &&
        sumInc.groups[0].key === "freelance" &&
        sumInc.groups[0].share_pct === 100 &&
        sumInc.groups[0].total === sumInc.total_income,
      JSON.stringify(sumInc)
    );
    const sumDrill = payload(await call("get_summary", { category: "restaurants", group_by: "merchant" }));
    ok(
      "get_summary category drill-down by merchant",
      sumDrill.category === "restaurants" &&
        sumDrill.groups.length === 2 &&
        sumDrill.groups.every((g: any) => ["Silpo", "Cafe"].includes(g.key)),
      JSON.stringify(sumDrill)
    );
    const sumExcl = payload(await call("get_summary", { exclude_categories: ["restaurants"] }));
    ok(
      "get_summary exclude_categories",
      sumExcl.total_expense === 0 && sumExcl.total_income > 0 && sumExcl.excluded_categories?.[0] === "restaurants",
      JSON.stringify(sumExcl)
    );

    const trends = payload(await call("get_trends", { months: 3 }));
    ok("get_trends buckets", trends.months.length === 3 && trends.months[2].expense > 0, JSON.stringify(trends));

    const bud = payload(await call("set_budget", { amount: 500 }));
    ok("set_budget overall", bud.ok === true);
    const prog = payload(await call("get_budget_progress", {}));
    ok("budget progress computed", prog.budgets?.[0]?.spent > 0 && prog.budgets[0].cap === 500, JSON.stringify(prog));

    const csvRes = await call("export_transactions", {});
    const csv = csvRes.json?.result?.content?.[0]?.text ?? "";
    ok("export CSV", csv.startsWith("date,type,") && csv.split("\n").length === 4);

    const del = payload(await call("delete_transaction", { id: e2.id }));
    ok("delete_transaction", del.deleted === true);

    const badCat = await call("log_expense", { amount: 5, category: "not-a-category" });
    ok("invalid category rejected", badCat.status !== 200 || isErr(badCat) || badCat.json?.error);

    // 12b-tel. Telemetry: tool calls + errors captured as events, no amounts/merchants leaked
    await Bun.sleep(400); // fire-and-forget writes settle
    const { db } = await import("../src/db");
    const since = new Date(Date.now() - 5 * 60_000);
    const telemetry = await db.event.findMany({ where: { type: "tool_call", createdAt: { gte: since } } });
    ok("telemetry: tool_call events written", telemetry.length >= 5, String(telemetry.length));
    const errEvent = telemetry.find((e: any) => e.meta?.error === true && String(e.meta?.tool) === "log_expense");
    ok("telemetry: error call captured with err text", !!errEvent && String((errEvent.meta as any).err).length > 0);
    const leaky = telemetry.filter((e: any) => {
      const s = JSON.stringify(e.meta);
      const keys = Object.keys(e.meta ?? {});
      return s.includes("Vitalvit") || s.includes("Silpo") || keys.some((k) => ["a_amount", "a_merchant", "a_note", "a_items"].includes(k));
    });
    ok("telemetry: no merchants/amounts leaked", leaky.length === 0, JSON.stringify(leaky[0]?.meta ?? {}));
    const initEv = await db.event.findFirst({ where: { type: "client_init", createdAt: { gte: since } } });
    ok("telemetry: clientInfo recorded", !!initEv && !!(initEv.meta as any)?.client);

    // 12c. Accounts, transfers, balances
    const accRev = payload(await call("create_account", { name: "Revolut", type: "bank", currency: "RON" }));
    ok("create_account Revolut RON", accRev.ok === true && accRev.currency === "RON");
    const accBroker = payload(await call("create_account", { name: "IBKR", type: "investment", currency: "USD" }));
    ok("create_account IBKR USD", accBroker.ok === true);

    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const snap = payload(await call("log_balance", { account: "Revolut", amount: 1000, date: yesterday }));
    ok("log_balance anchors Revolut", snap.ok === true && snap.balance === 1000 && snap.currency === "RON");

    const spent = payload(await call("log_expense", { amount: 145, account: "revolut", category: "health", merchant: "Vitalvit" }));
    ok("log_expense on account (case-insensitive)", spent.currency === "RON", JSON.stringify(spent));

    const tr = payload(
      await call("log_transfer", { amount: 46.05, from_account: "Revolut", to_account: "IBKR", received_amount: 10, received_currency: "USD" })
    );
    ok("log_transfer cross-currency", tr.transfer === "Revolut -> IBKR" && tr.received.currency === "USD", JSON.stringify(tr));

    const accounts = payload(await call("get_accounts", {}));
    const rev = accounts.accounts.find((a: any) => a.name === "Revolut");
    const ibkr = accounts.accounts.find((a: any) => a.name === "IBKR");
    ok("Revolut balance = snapshot - expense - transfer", rev.balance === round2c(1000 - 145 - 46.05), JSON.stringify(rev));
    ok("IBKR received 10 USD", ibkr.balance === 10, JSON.stringify(ibkr));
    ok("net worth computed in base", accounts.net_worth > 0 && accounts.base_currency === "EUR");

    const sumAfterTransfer = payload(await call("get_summary", {}));
    ok(
      "transfer excluded from spending",
      sumAfterTransfer.total_expense === round2c(sum.total_expense - 12.5 + spent.amount_base),
      JSON.stringify({ before: sum.total_expense, after: sumAfterTransfer.total_expense })
    );

    // 12d. Bulk import with dedup + reconciliation
    const imp = payload(
      await call("import_transactions", {
        account: "Revolut",
        statement_total: -173.01,
        transactions: [
          { date: today(), amount: -145, merchant: "Vitalvit SRL", category: "health" }, // dup of logged expense
          { date: today(), amount: -14, merchant: "A Roastery", category: "restaurants", external_id: "stmt-001" },
          { date: today(), amount: -14.01, merchant: "Weird Shop", category: "not-real-category" },
        ],
      })
    );
    ok("import: dup skipped", imp.duplicates_skipped === 1, JSON.stringify(imp));
    ok("import: 2 imported", imp.imported === 2);
    ok("import: category coerced", imp.unknown_categories_coerced_to_other === 1);
    ok("import: reconciliation ok", imp.reconciliation === "ok");

    const impReplay = payload(
      await call("import_transactions", {
        account: "Revolut",
        transactions: [{ date: today(), amount: -14, merchant: "A Roastery", external_id: "stmt-001" }],
      })
    );
    ok("import replay: external_id dedup", impReplay.imported === 0 && impReplay.duplicates_skipped === 1);

    const impBad = payload(
      await call("import_transactions", {
        account: "Revolut",
        statement_total: -500,
        transactions: [{ date: today(), amount: -20, merchant: "Gap Store" }],
      })
    );
    ok("import: mismatch flagged", String(impBad.reconciliation).startsWith("MISMATCH"), JSON.stringify(impBad));

    // 12e. Cross-account dedup: hand-logged row on Manual must block its bank twin on Revolut
    const handLogged = payload(await call("log_expense", { amount: 33.33, currency: "RON", category: "clothing", merchant: "Zara" }));
    const impCross = payload(
      await call("import_transactions", {
        account: "Revolut",
        transactions: [{ date: today(), amount: -33.33, merchant: "ZARA ROMANIA SRL" }],
      })
    );
    ok(
      "import: manual twin on other account merged",
      impCross.duplicates_skipped === 1 &&
        impCross.imported === 0 &&
        impCross.manual_twins_merged === 1 &&
        impCross.skipped?.[0]?.reason === "manual_twin_merged",
      JSON.stringify(impCross)
    );
    const zaraAfter = payload(await call("get_transactions", { merchant: "Zara" }));
    ok(
      "merged twin moved to bank account, category kept",
      zaraAfter.transactions[0].account === "Revolut" && zaraAfter.transactions[0].category === "clothing",
      JSON.stringify(zaraAfter.transactions[0])
    );

    // 12g. Dedup precision: recurring merchants, same-day twins, external_id authority
    const lime = payload(
      await call("import_transactions", {
        account: "Revolut",
        transactions: [
          { date: "2026-04-17", amount: -9.5, currency: "RON", merchant: "Lime Ride", category: "transport" },
          { date: "2026-04-18", amount: -9.5, currency: "RON", merchant: "Lime Ride", category: "transport" },
          { date: "2026-04-20", amount: -9.5, currency: "RON", merchant: "Lime Ride", category: "transport" },
          { date: "2026-04-20", amount: -9.5, currency: "RON", merchant: "Lime Ride", category: "transport" },
        ],
      })
    );
    ok("import: recurring merchant+amount not deduped", lime.imported === 4 && lime.duplicates_skipped === 0, JSON.stringify(lime));

    const limeReplay = payload(
      await call("import_transactions", {
        account: "Revolut",
        transactions: [
          { date: "2026-04-17", amount: -9.5, currency: "RON", merchant: "Lime Ride", category: "transport" },
          { date: "2026-04-20", amount: -9.5, currency: "RON", merchant: "Lime Ride", category: "transport" },
          { date: "2026-04-20", amount: -9.5, currency: "RON", merchant: "Lime Ride", category: "transport" },
        ],
      })
    );
    ok("import replay: exact bank rows deduped", limeReplay.imported === 0 && limeReplay.duplicates_skipped === 3, JSON.stringify(limeReplay));

    const atm = payload(
      await call("import_transactions", {
        account: "Revolut",
        transactions: [
          { date: "2026-05-17", amount: -900, currency: "RON", merchant: "Cash withdrawal at Str. Vasile Alecsandri", type: "transfer", external_id: "e2e-atm-1" },
          { date: "2026-05-18", amount: -900, currency: "RON", merchant: "Cash withdrawal at Str. Vasile Alecsandri", type: "transfer", external_id: "e2e-atm-2" },
        ],
      })
    );
    ok("import: distinct external_ids never merged", atm.imported === 2 && atm.duplicates_skipped === 0, JSON.stringify(atm));

    const coffeeManual = payload(
      await call("log_expense", { amount: 4.5, currency: "RON", category: "restaurants", merchant: "5 to go", date: "2026-04-25" })
    );
    const impCoffee = payload(
      await call("import_transactions", {
        account: "Revolut",
        transactions: [
          { date: "2026-04-25", amount: -4.5, currency: "RON", merchant: "5 TO GO SRL" },
          { date: "2026-04-26", amount: -4.5, currency: "RON", merchant: "5 TO GO SRL" },
        ],
      })
    );
    ok(
      "import: manual twin absorbs ONE bank row only",
      impCoffee.duplicates_skipped === 1 && impCoffee.imported === 1 && impCoffee.manual_twins_merged === 1,
      JSON.stringify(impCoffee)
    );
    void coffeeManual;

    // 12h. Dry run, synthetic-key idempotency under merchant drift, real-id upgrade
    const dryRows = [
      { date: "2026-04-28", amount: -77.7, currency: "RON", merchant: "AAA Market" },
      { date: "2026-04-28", amount: -77.7, currency: "RON", merchant: "AAA Market" },
    ];
    const dry = payload(await call("import_transactions", { account: "Revolut", dry_run: true, transactions: dryRows }));
    ok("dry_run: previews without writing", dry.dry_run === true && dry.imported === 2, JSON.stringify(dry));
    const wet = payload(await call("import_transactions", { account: "Revolut", transactions: dryRows }));
    ok("dry_run wrote nothing: same rows import for real", wet.imported === 2 && wet.duplicates_skipped === 0, JSON.stringify(wet));
    const drift = payload(
      await call("import_transactions", {
        account: "Revolut",
        transactions: [
          { date: "2026-04-28", amount: -77.7, currency: "RON", merchant: "AAA MARKET SRL CLUJ 042" },
          { date: "2026-04-28", amount: -77.7, currency: "RON", merchant: "aaa market" },
        ],
      })
    );
    ok(
      "re-import with drifted merchant wording deduped",
      drift.imported === 0 && drift.duplicates_skipped === 2 && drift.skipped?.length === 2,
      JSON.stringify(drift)
    );

    const leg1 = payload(
      await call("import_transactions", {
        account: "Revolut",
        transactions: [{ date: "2026-05-02", amount: -55, currency: "RON", merchant: "Carrefour", external_id: "e2e-leg-1" }],
      })
    );
    const leg2 = payload(
      await call("import_transactions", {
        account: "Revolut",
        transactions: [{ date: "2026-05-02", amount: -55, currency: "RON", merchant: "CARREFOUR ROMANIA SA" }],
      })
    );
    ok(
      "row without id matches existing bank row same day+amount",
      leg1.imported === 1 && leg2.imported === 0 && leg2.skipped?.[0]?.reason === "already_imported",
      JSON.stringify(leg2)
    );

    const up1 = payload(
      await call("import_transactions", {
        account: "Revolut",
        transactions: [{ date: "2026-05-03", amount: -21.4, currency: "RON", merchant: "Mega Image" }],
      })
    );
    const up2 = payload(
      await call("import_transactions", {
        account: "Revolut",
        transactions: [{ date: "2026-05-03", amount: -21.4, currency: "RON", merchant: "Mega Image", external_id: "e2e-up-1" }],
      })
    );
    const up3 = payload(
      await call("import_transactions", {
        account: "Revolut",
        transactions: [{ date: "2026-05-03", amount: -21.4, currency: "RON", merchant: "Mega Image", external_id: "e2e-up-1" }],
      })
    );
    ok(
      "bank row upgraded from synthetic to real external_id",
      up1.imported === 1 && up2.duplicates_skipped === 1 && up3.skipped?.[0]?.reason === "external_id_exists",
      JSON.stringify({ up2, up3 })
    );

    // 12i. Chunk-collision recovery protocol: a second call with an identical no-id row
    // looks like a re-import (skipped + hint); re-sending with external_id + force recovers it.
    const chunkA = payload(
      await call("import_transactions", {
        account: "Revolut",
        transactions: [{ date: "2026-03-06", amount: -33, currency: "RON", merchant: "Shop A" }],
      })
    );
    const chunkB = payload(
      await call("import_transactions", {
        account: "Revolut",
        transactions: [{ date: "2026-03-06", amount: -33, currency: "RON", merchant: "Shop B" }],
      })
    );
    ok(
      "continuation chunk without ids collides and returns hint",
      chunkA.imported === 1 && chunkB.imported === 0 && typeof chunkB.hint === "string" && chunkB.hint.includes("force"),
      JSON.stringify(chunkB)
    );
    const chunkRetry = payload(
      await call("import_transactions", {
        account: "Revolut",
        transactions: [
          { date: "2026-03-06", amount: -33, currency: "RON", merchant: "Shop B", external_id: "e2e-chunk-b1", force: true },
        ],
      })
    );
    const chunkReplay = payload(
      await call("import_transactions", {
        account: "Revolut",
        transactions: [
          { date: "2026-03-06", amount: -33, currency: "RON", merchant: "Shop B", external_id: "e2e-chunk-b1", force: true },
        ],
      })
    );
    ok(
      "forced re-send recovers the row, stays idempotent",
      chunkRetry.imported === 1 && chunkReplay.imported === 0 && chunkReplay.skipped?.[0]?.reason === "external_id_exists",
      JSON.stringify({ chunkRetry, chunkReplay })
    );

    // 12j. Entity scope: personal vs business separation
    const biz = payload(await call("create_account", { name: "BizBank", type: "bank", currency: "EUR", entity: "business" }));
    ok("create_account with entity", biz.ok === true && biz.entity === "business", JSON.stringify(biz));

    const bizExp = payload(
      await call("log_expense", { amount: 200, account: "BizBank", category: "business", merchant: "Hetzner", date: "2026-02-10" })
    );
    ok("expense inherits account entity", bizExp.entity === "business", JSON.stringify(bizExp));

    const persOnBiz = payload(
      await call("log_expense", {
        amount: 40,
        account: "BizBank",
        category: "restaurants",
        merchant: "Dinner Bali",
        date: "2026-02-10",
        entity: "personal",
      })
    );
    ok("entity override on business card", persOnBiz.entity === "personal", JSON.stringify(persOnBiz));

    const impEnt = payload(
      await call("import_transactions", {
        account: "BizBank",
        transactions: [
          { date: "2026-02-11", amount: -60, merchant: "AWS", category: "business" },
          { date: "2026-02-11", amount: -25, merchant: "Vienna Shopping", category: "clothing", entity: "personal" },
        ],
      })
    );
    ok("import: rows scoped by account + override", impEnt.imported === 2, JSON.stringify(impEnt));

    const sumBiz = payload(await call("get_summary", { period: "2026-02", entity: "business" }));
    const sumPers = payload(await call("get_summary", { period: "2026-02", entity: "personal" }));
    const sumAll = payload(await call("get_summary", { period: "2026-02" }));
    ok(
      "summary splits by entity",
      sumBiz.total_expense === 260 && sumPers.total_expense === 65 && sumAll.total_expense === 325,
      JSON.stringify({ business: sumBiz.total_expense, personal: sumPers.total_expense, all: sumAll.total_expense })
    );

    const sumMon = payload(await call("get_summary", { from: "2026-02-01", to: "2099-01-01", group_by: "month" }));
    const monthKeys = sumMon.groups.map((g: any) => g.key);
    ok(
      "summary by month is chronological",
      monthKeys.length >= 2 && monthKeys.every((k: string, i: number) => i === 0 || k > monthKeys[i - 1]!),
      JSON.stringify(monthKeys)
    );

    const txPers = payload(await call("get_transactions", { from: "2026-02-01", to: "2026-02-28", entity: "personal" }));
    ok(
      "transactions filtered by entity",
      txPers.count === 2 && txPers.transactions.every((t: any) => t.entity === "personal"),
      JSON.stringify(txPers.count)
    );

    const flip = payload(await call("update_transaction", { id: bizExp.id, entity: "personal" }));
    const sumPers2 = payload(await call("get_summary", { period: "2026-02", entity: "personal" }));
    ok("update_transaction reclassifies scope", flip.entity === "personal" && sumPers2.total_expense === 265, JSON.stringify(sumPers2.total_expense));

    const progBefore = payload(await call("get_budget_progress", {}));
    await call("log_expense", { amount: 999, account: "BizBank", category: "business", merchant: "Big Biz Spend" });
    const progAfter = payload(await call("get_budget_progress", {}));
    ok(
      "business spend never hits budgets",
      JSON.stringify(progBefore.budgets) === JSON.stringify(progAfter.budgets),
      JSON.stringify({ before: progBefore.budgets?.[0], after: progAfter.budgets?.[0] })
    );

    const accsEnt = payload(await call("get_accounts", {}));
    const bizAcc = accsEnt.accounts.find((a: any) => a.name === "BizBank");
    ok(
      "accounts expose entity + split net worth",
      bizAcc.entity === "business" && !!accsEnt.net_worth_by_entity,
      JSON.stringify(accsEnt.net_worth_by_entity)
    );

    const csvEnt = await call("export_transactions", { entity: "business" });
    const csvText: string = csvEnt.json?.result?.content?.[0]?.text ?? "";
    ok(
      "export filters by entity + column",
      csvText.split("\n")[0]!.endsWith(",entity") && csvText.includes(",business") && !csvText.includes(",personal"),
      csvText.split("\n")[0]
    );

    // 12k. ZenMoney connector: connect -> full sync -> incremental -> protections
    const zenBad = await call("connect_zenmoney", { action: "paste_token", token: "wrong-token-000000" });
    ok("zenmoney rejects bad token", isErr(zenBad), JSON.stringify(zenBad.json));

    const zenConn = payload(await call("connect_zenmoney", { action: "paste_token", token: ZEN_TOKEN }));
    ok("zenmoney connect", zenConn.connected === true, JSON.stringify(zenConn));

    // Hand-logged twin the sync must merge instead of duplicating (15 EUR = zt6)
    const twin = payload(await call("log_expense", { amount: 15, currency: "EUR", category: "restaurants", merchant: "Trattoria", date: "2026-07-12" }));
    ok("zen twin pre-logged", !!twin.id);

    // P1/P2: same-name account owned by ANOTHER provider - zen must NOT adopt
    // it (create with suffix instead) and must warn about the overlap.
    const { db: pdb } = await import("../src/db");
    const zenUser = await pdb.user.findFirstOrThrow({ where: { email: EMAIL } });
    await pdb.account.create({
      data: { userId: zenUser.id, name: "Zen Cash", type: "cash", provider: "enablebanking", externalId: "eb-foreign", currency: "EUR" },
    });

    const zs1 = payload(await call("sync_zenmoney", {}));
    ok(
      "zen first sync report",
      zs1.first_sync === true &&
        zs1.accounts_created === 2 &&
        zs1.accounts_synced === 2 &&
        zs1.accounts_skipped?.length === 2 &&
        zs1.imported === 3 &&
        zs1.transfers === 1 &&
        zs1.manual_twins_merged === 1 &&
        zs1.rows_on_unsynced_accounts === 1 &&
        zs1.balances_anchored === 2,
      JSON.stringify(zs1)
    );
    ok(
      "zen unmapped tag surfaced",
      zs1.unmapped_tags?.length === 1 && zs1.unmapped_tags[0].tag === "Гараж" && zs1.unmapped_tags[0].count === 1,
      JSON.stringify(zs1.unmapped_tags)
    );
    ok(
      "zen skips cross-provider adopt + overlap warning",
      zs1.overlap_warnings?.length === 1 &&
        zs1.overlap_warnings[0].created_account === "Zen Cash (EUR)" &&
        zs1.overlap_warnings[0].existing_account === "Zen Cash" &&
        zs1.overlap_warnings[0].existing_provider === "enablebanking",
      JSON.stringify(zs1.overlap_warnings)
    );

    const zenAccs = payload(await call("get_accounts", {}));
    const zenCard = zenAccs.accounts.find((a: any) => a.name === "Zen Card");
    ok("zen balances anchored", zenCard?.balance === 900 && zenCard?.anchored_at, JSON.stringify(zenCard));

    const zenLidl = payload(await call("get_transactions", { merchant: "Lidl" }));
    ok(
      "zen tag dictionary mapped",
      zenLidl.count === 1 && zenLidl.transactions[0].category === "groceries",
      JSON.stringify(zenLidl.transactions)
    );
    const zenTwin = payload(await call("get_transactions", { merchant: "Trattoria" }));
    ok(
      "zen twin merged to synced account, category kept",
      zenTwin.count === 1 && zenTwin.transactions[0].account === "Zen Card" && zenTwin.transactions[0].category === "restaurants",
      JSON.stringify(zenTwin.transactions)
    );

    // User edits the salary row -> incremental sync must NOT delete it
    const zenSalary = payload(await call("get_transactions", { category: "salary" }));
    ok("zen salary imported", zenSalary.count === 1, JSON.stringify(zenSalary));
    await Bun.sleep(2100); // outlive the touch grace window
    const touchUpd = payload(await call("update_transaction", { id: zenSalary.transactions[0].id, note: "user edit" }));
    ok("zen salary touched by user", touchUpd.updated === true);

    const zs2 = payload(await call("sync_zenmoney", {}));
    ok(
      "zen incremental: update + deletion + user-edit protection",
      zs2.first_sync === false &&
        zs2.imported === 0 &&
        zs2.updated === 1 &&
        zs2.deleted === 1 &&
        zs2.kept_user_modified === 1,
      JSON.stringify(zs2)
    );
    const zenLidl2 = payload(await call("get_transactions", { merchant: "Lidl" }));
    ok("zen changed amount applied", zenLidl2.transactions[0].amount === 55, JSON.stringify(zenLidl2.transactions));
    const zenSalary2 = payload(await call("get_transactions", { category: "salary" }));
    ok("zen user-edited row survived deletion", zenSalary2.count === 1);

    const zs3 = payload(await call("sync_zenmoney", {}));
    ok("zen idempotent re-sync", zs3.imported === 0 && zs3.updated === 0 && zs3.deleted === 0, JSON.stringify(zs3));
    ok("zen overlap warning fires only on creation", zs3.overlap_warnings === undefined, JSON.stringify(zs3));

    const zenStatus = payload(await call("connect_zenmoney", { action: "status" }));
    ok(
      "zen status",
      zenStatus.connected === true && zenStatus.status === "active" && zenStatus.accounts_synced === 2 && !!zenStatus.last_sync,
      JSON.stringify(zenStatus)
    );
    const zenDisc = payload(await call("connect_zenmoney", { action: "disconnect" }));
    ok("zen disconnect", zenDisc.disconnected === true);
    const zenSyncAfter = await call("sync_zenmoney", {});
    ok("zen sync after disconnect errors", isErr(zenSyncAfter));
    const zenLidl3 = payload(await call("get_transactions", { merchant: "Lidl" }));
    ok("zen imported rows kept after disconnect", zenLidl3.count === 1);

    // 12eb. Enable Banking connector: consent flow + sync semantics
    const ebList = payload(await call("connect_bank", { action: "list_banks", country: "FI" }));
    ok("eb list_banks", ebList.banks?.includes("Mock Bank"), JSON.stringify(ebList));

    const ebBadBank = await call("connect_bank", { action: "start", country: "FI", bank_name: "No Such Bank" });
    ok("eb start rejects unknown bank", isErr(ebBadBank));

    const ebStart = payload(await call("connect_bank", { action: "start", country: "FI", bank_name: "Mock Bank" }));
    ok("eb start returns authorize_url", typeof ebStart.authorize_url === "string" && ebStart.authorize_url.includes("/connect/enablebanking/callback"), JSON.stringify(ebStart));

    const ebSyncEarly = await call("sync_bank", {});
    ok("eb sync before consent errors", isErr(ebSyncEarly));

    const badState = await fetch(`${BASE}/connect/enablebanking/callback?code=x&state=wrong-state`);
    ok("eb callback rejects unknown state", badState.status === 400);

    // Twin: hand-logged before the bank confirms the same 15.30 EUR spend
    await call("log_expense", { amount: 15.3, currency: "EUR", category: "restaurants", merchant: "Cafe X", date: "2026-07-16" });

    // Name clash: the user already tracks "Main Account" by hand (CSV-import style)
    await call("create_account", { name: "Main Account", type: "bank", currency: "EUR" });
    // Orphan from an "interrupted" earlier sync: created but never mapped
    const { db: odb } = await import("../src/db");
    const testUser = await odb.user.findFirstOrThrow({ where: { email: EMAIL } });
    await odb.account.create({
      data: { userId: testUser.id, name: "Orphan Savings", type: "bank", provider: "enablebanking", externalId: "eb-acc-2", currency: "EUR" },
    });

    const consent = await fetch(ebStart.authorize_url);
    ok("eb consent callback succeeds", consent.status === 200 && (await consent.text()).includes("Bank connected"));

    const ebs1 = payload(await call("sync_bank", {}));
    ok("eb first sync counts", ebs1.accounts_created === 2 && ebs1.imported === 2 && ebs1.transfers === 1 && ebs1.manual_twins_merged === 1, JSON.stringify(ebs1));
    ok("eb pending skipped + balances anchored", ebs1.pending_rows_skipped === 1 && ebs1.balances_anchored === 3, JSON.stringify(ebs1));

    const ebAccs = payload(await call("get_accounts", {}));
    const ebNames = ebAccs.accounts.map((a: any) => a.name);
    ok(
      "eb multi-currency naming + orphan adoption",
      ebNames.includes("Main Account (EUR)") &&
        ebNames.includes("Main Account (RON)") &&
        ebNames.includes("Orphan Savings") &&
        !ebNames.includes("Savings"),
      JSON.stringify(ebNames)
    );

    const ebLidl = payload(await call("get_transactions", { merchant: "Lidl Helsinki" }));
    ok("eb mcc category mapping", ebLidl.count === 1 && ebLidl.transactions[0].category === "groceries", JSON.stringify(ebLidl));

    const ebs2 = payload(await call("sync_bank", {}));
    ok("eb idempotent re-sync (transfer credit side included)", ebs2.imported === 0 && ebs2.transfers === 0 && ebs2.updated === 0 && ebs2.manual_twins_merged === 0, JSON.stringify(ebs2));

    // 12eb2. Type conversion (0.10.0): cash-withdrawal-style fix into a transfer
    await call("create_account", { name: "Cash Stash", type: "cash", currency: "EUR" });
    const lidlId = ebLidl.transactions[0].id;
    const noCounter = await call("update_transaction", { id: lidlId, type: "transfer" });
    ok("convert to transfer requires counter_account", isErr(noCounter));
    const conv = payload(await call("update_transaction", { id: lidlId, type: "transfer", counter_account: "Cash Stash" }));
    ok("expense converted to transfer", conv.type === "transfer" && conv.category === null && conv.transfer === true, JSON.stringify(conv));
    const ebs3 = payload(await call("sync_bank", {}));
    ok("converted transfer survives re-sync untouched", ebs3.imported === 0 && ebs3.transfers === 0 && ebs3.updated === 0, JSON.stringify(ebs3));
    const convBack = payload(await call("update_transaction", { id: lidlId, type: "expense", category: "groceries" }));
    ok("transfer converted back to expense", convBack.type === "expense" && convBack.category === "groceries", JSON.stringify(convBack));

    // 12eb3. Merchant category memory: one manual fix sticks on future imports
    const cafe = payload(await call("get_transactions", { merchant: "Cafe X" }));
    await call("update_transaction", { id: cafe.transactions[0].id, category: "entertainment" });
    await call("delete_transaction", { id: cafe.transactions[0].id });
    const ebs4 = payload(await call("sync_bank", {}));
    ok("deleted bank row re-imports on sync", ebs4.imported === 1, JSON.stringify(ebs4));
    const cafe2 = payload(await call("get_transactions", { merchant: "Cafe X" }));
    ok(
      "merchant memory categorizes re-import",
      cafe2.count === 1 && cafe2.transactions[0].category === "entertainment",
      JSON.stringify(cafe2)
    );

    // 12eb4. Daily auto-sync: the server-side scheduler syncs stale connections
    const { db: adb } = await import("../src/db");
    await adb.bankConnection.updateMany({
      where: { provider: "enablebanking" },
      data: { lastSyncAt: new Date(Date.now() - 30 * 3600 * 1000) },
    });
    const { runAutoSync } = await import("../src/autosync");
    const auto = await runAutoSync();
    ok("auto-sync syncs the stale connection", auto.due >= 1 && auto.synced >= 1 && auto.failed === 0, JSON.stringify(auto));
    const ebStatusAuto = payload(await call("connect_bank", { action: "status" }));
    ok(
      "auto-sync refreshed last_sync",
      !!ebStatusAuto.last_sync && Date.now() - new Date(ebStatusAuto.last_sync).getTime() < 60_000,
      JSON.stringify({ last_sync: ebStatusAuto.last_sync })
    );

    const ebStatus = payload(await call("connect_bank", { action: "status" }));
    ok("eb status", ebStatus.connected === true && ebStatus.bank === "Mock Bank" && ebStatus.accounts_synced === 3 && !!ebStatus.consent_valid_until, JSON.stringify(ebStatus));
    ok(
      "eb status lists synced accounts",
      Array.isArray(ebStatus.accounts) && ebStatus.accounts.length === 3 && ebStatus.accounts.every((a: any) => a.enabled === true && a.id && a.name),
      JSON.stringify(ebStatus.accounts)
    );

    // 12eb5. set_account_sync: per-account toggle
    const togBad = await call("connect_bank", { action: "set_account_sync", account: "No Such Acc", enabled: false });
    ok("set_account_sync unknown account errors", isErr(togBad));
    const togOff = payload(await call("connect_bank", { action: "set_account_sync", account: "Main Account (EUR)", enabled: false }));
    ok("set_account_sync disables", togOff.enabled === false && togOff.account === "Main Account (EUR)", JSON.stringify(togOff));
    const stTog = payload(await call("connect_bank", { action: "status" }));
    ok(
      "status reflects disabled account",
      stTog.accounts_synced === 2 && stTog.accounts.find((a: any) => a.name === "Main Account (EUR)")?.enabled === false,
      JSON.stringify(stTog.accounts)
    );
    const cafeTog = payload(await call("get_transactions", { merchant: "Cafe X" }));
    await call("delete_transaction", { id: cafeTog.transactions[0].id });
    const ebs5 = payload(await call("sync_bank", {}));
    ok("disabled account not pulled", ebs5.imported === 0 && ebs5.accounts_synced === 2, JSON.stringify(ebs5));
    const togOn = payload(await call("connect_bank", { action: "set_account_sync", account: "Main Account (EUR)", enabled: true }));
    ok("set_account_sync re-enables", togOn.enabled === true, JSON.stringify(togOn));
    const ebs6 = payload(await call("sync_bank", {}));
    ok("re-enabled account pulls again", ebs6.imported === 1, JSON.stringify(ebs6));

    const ebDisc = payload(await call("connect_bank", { action: "disconnect" }));
    ok("eb disconnect", ebDisc.disconnected === true);
    const ebSyncAfter = await call("sync_bank", {});
    ok("eb sync after disconnect errors", isErr(ebSyncAfter));
    const ebLidl2 = payload(await call("get_transactions", { merchant: "Lidl Helsinki" }));
    ok("eb imported rows kept after disconnect", ebLidl2.count === 1);

    // 12f. Bulk delete
    const listForDel = payload(await call("get_transactions", { limit: 3 }));
    const delIds = listForDel.transactions.map((t: any) => t.id);
    const bulkDel = payload(await call("delete_transactions", { ids: delIds }));
    ok("bulk delete by ids", bulkDel.deleted === delIds.length, JSON.stringify(bulkDel));

    // 12g. Account management: update_account + delete_account (one account, not GDPR)
    const tmpA = payload(await call("create_account", { name: "Temp Acc", type: "cash", currency: "EUR" }));
    ok("create temp account", tmpA.ok === true);
    const updNoop = await call("update_account", { account: "Temp Acc" });
    ok("update_account requires a change", isErr(updNoop));
    const updClash = await call("update_account", { account: "Temp Acc", new_name: "Cash Stash" });
    ok("update_account rejects name clash", isErr(updClash));
    const updAcc = payload(await call("update_account", { account: "Temp Acc", new_name: "Temp Renamed", entity: "business", type: "bank" }));
    ok(
      "update_account renames + retypes",
      updAcc.ok === true && updAcc.account === "Temp Renamed" && updAcc.entity === "business" && updAcc.type === "bank",
      JSON.stringify(updAcc)
    );
    await call("log_expense", { amount: 5, currency: "EUR", category: "groceries", account: "Temp Renamed" });
    const delGuard = await call("delete_account", { account: "Temp Renamed" });
    ok("delete_account guards non-empty account", isErr(delGuard));
    const delAcc = payload(await call("delete_account", { account: "Temp Renamed", delete_transactions: true }));
    ok("delete_account cascades transactions", delAcc.deleted === "Temp Renamed" && delAcc.transactions_deleted === 1, JSON.stringify(delAcc));
    const accsAfterDel = payload(await call("get_accounts", {}));
    ok("deleted account gone", !accsAfterDel.accounts.some((a: any) => a.name === "Temp Renamed"), JSON.stringify(accsAfterDel.accounts.map((a: any) => a.name)));

    // 12h. merge_accounts: CSV-style account folded into another with dedup
    await call("create_account", { name: "Merge Src", type: "bank", currency: "EUR" });
    await call("create_account", { name: "Merge Dst", type: "bank", currency: "EUR" });
    await call("log_expense", { amount: 20, currency: "EUR", category: "other", merchant: "DupShop", date: "2026-07-10", account: "Merge Dst" });
    await call("log_expense", { amount: 20, currency: "EUR", category: "groceries", merchant: "DupShop CSV", date: "2026-07-11", account: "Merge Src" });
    await call("log_income", { amount: 77, currency: "EUR", category: "other", merchant: "UniqPay", date: "2026-07-01", account: "Merge Src" });
    await call("log_transfer", { amount: 5, from_account: "Merge Src", to_account: "Merge Dst", date: "2026-07-12" });
    await call("log_transfer", { amount: 7, from_account: "Cash Stash", to_account: "Merge Src", date: "2026-07-12" });

    const mSame = await call("merge_accounts", { source: "Merge Src", target: "Merge Src" });
    ok("merge rejects same account", isErr(mSame));
    const mDry = payload(await call("merge_accounts", { source: "Merge Src", target: "Merge Dst", dry_run: true }));
    ok(
      "merge dry_run counts",
      mDry.dry_run === true && mDry.moved === 1 && mDry.merged_duplicates === 1 && mDry.internal_transfers_removed === 1 && mDry.transfer_refs_rewritten === 1,
      JSON.stringify(mDry)
    );
    const mReal = payload(await call("merge_accounts", { source: "Merge Src", target: "Merge Dst" }));
    ok("merge executes", mReal.moved === 1 && mReal.merged_duplicates === 1 && mReal.source_deleted === true, JSON.stringify(mReal));
    const mAccs = payload(await call("get_accounts", {}));
    ok("merge source gone", !mAccs.accounts.some((a: any) => a.name === "Merge Src"), JSON.stringify(mAccs.accounts.map((a: any) => a.name)));
    const mDup = payload(await call("get_transactions", { merchant: "DupShop" }));
    ok("merge winner absorbed category", mDup.count === 1 && mDup.transactions[0].category === "groceries", JSON.stringify(mDup.transactions));
    const mUniq = payload(await call("get_transactions", { merchant: "UniqPay" }));
    ok("merge moved unique row", mUniq.count === 1 && mUniq.transactions[0].account === "Merge Dst", JSON.stringify(mUniq.transactions));
    const mDst = mAccs.accounts.find((a: any) => a.name === "Merge Dst");
    ok("merge counter rewrite + balance", mDst?.balance === 64, JSON.stringify(mDst));
    void handLogged;
  } else {
    const settings = await mcpCall(tokens.access_token, {
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: { name: "get_settings", arguments: {} },
    });
    const s = JSON.parse(settings.json?.result?.content?.[0]?.text ?? "{}");
    ok("get_settings (read-only prod smoke)", !!s.base_currency, JSON.stringify(s));
  }

  // 13. Refresh token rotation
  const refreshRes = await fetch(asMeta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    }),
  });
  const refreshed: any = await refreshRes.json();
  ok("refresh -> new tokens", refreshRes.status === 200 && !!refreshed.access_token);
  const oldRefresh = await fetch(asMeta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    }),
  });
  ok("old refresh token invalidated", oldRefresh.status === 400);
  const pingNew = await mcpCall(refreshed.access_token, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "ping", arguments: {} },
  });
  ok("new access token works", pingNew.status === 200);

  // 14. GDPR wipe (spawn mode only) - last, since it also revokes all tokens
  if (!externalBase) {
    const wipeRes = await mcpCall(refreshed.access_token, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "delete_all_data", arguments: { confirm: "DELETE" } },
    });
    const wipe = JSON.parse(wipeRes.json?.result?.content?.[0]?.text ?? "{}");
    ok("delete_all_data wipes test user", wipe.deleted === true, JSON.stringify(wipeRes.json));
    const afterWipe = await mcpCall(refreshed.access_token, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "ping", arguments: {} } });
    ok("wiped user token rejected", afterWipe.status === 401);
  }

  console.log(`\ne2e PASSED: ${passed} checks green.`);
}

try {
  await main();
} finally {
  (serverProc as Subprocess | null)?.kill();
  // The Zen stub's listener would otherwise keep the Bun event loop alive
  // forever after main() returns - the script must exit for CI/deploy gates.
  (zenStub as { stop: (closeActiveConnections?: boolean) => void } | null)?.stop(true);
  (ebStub as { stop: (closeActiveConnections?: boolean) => void } | null)?.stop(true);
}
