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

async function main(): Promise<void> {
  if (!externalBase) {
    // Idempotency: a previously crashed run may have left the test user behind
    const { db } = await import("../src/db");
    await db.user.deleteMany({ where: { email: EMAIL } });
    const hash = await Bun.password.hash(PASSWORD);
    serverProc = Bun.spawn(["bun", "run", "src/index.ts"], {
      env: {
        ...process.env,
        PORT: String(PORT),
        BASE_URL: BASE,
        FINANCE_MCP_EMAIL: EMAIL,
        FINANCE_MCP_PASSWORD_HASH: hash,
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

  // 1. Discovery
  const asMeta: any = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  ok("AS metadata", !!asMeta.authorization_endpoint && !!asMeta.token_endpoint);
  ok("PKCE S256 advertised", asMeta.code_challenge_methods_supported?.includes("S256"));
  const prm: any = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  ok("protected resource metadata", prm.resource?.endsWith("/mcp"));

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
  ok("MCP initialize", init.status === 200 && init.json?.result?.serverInfo?.name === "financemcp", JSON.stringify(init.json));

  // 11. tools/list
  const list = await mcpCall(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolNames = (list.json?.result?.tools ?? []).map((t: any) => t.name);
  ok("tools/list has ping", toolNames.includes("ping"), JSON.stringify(toolNames));

  // 11b. MCP Apps: tool _meta links + UI resource served
  const sumTool = (list.json?.result?.tools ?? []).find((t: any) => t.name === "get_summary");
  ok(
    "get_summary linked to dashboard UI",
    sumTool?._meta?.ui?.resourceUri === "ui://financemcp/dashboard",
    JSON.stringify(sumTool?._meta)
  );
  const uiRes = await mcpCall(tokens.access_token, {
    jsonrpc: "2.0",
    id: 21,
    method: "resources/read",
    params: { uri: "ui://financemcp/dashboard" },
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
    ok("import: manual twin on other account deduped", impCross.duplicates_skipped === 1 && impCross.imported === 0, JSON.stringify(impCross));

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
    ok("import: manual twin absorbs ONE bank row only", impCoffee.duplicates_skipped === 1 && impCoffee.imported === 1, JSON.stringify(impCoffee));
    void coffeeManual;

    // 12f. Bulk delete
    const listForDel = payload(await call("get_transactions", { limit: 3 }));
    const delIds = listForDel.transactions.map((t: any) => t.id);
    const bulkDel = payload(await call("delete_transactions", { ids: delIds }));
    ok("bulk delete by ids", bulkDel.deleted === delIds.length, JSON.stringify(bulkDel));
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
      params: { name: "delete_account", arguments: { confirm: "DELETE" } },
    });
    const wipe = JSON.parse(wipeRes.json?.result?.content?.[0]?.text ?? "{}");
    ok("delete_account wipes test user", wipe.deleted === true, JSON.stringify(wipeRes.json));
    const afterWipe = await mcpCall(refreshed.access_token, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "ping", arguments: {} } });
    ok("wiped user token rejected", afterWipe.status === 401);
  }

  console.log(`\ne2e PASSED: ${passed} checks green.`);
}

try {
  await main();
} finally {
  (serverProc as Subprocess | null)?.kill();
}
