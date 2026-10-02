/**
 * Gate A end-to-end proof, self-contained:
 * spawns the server with test credentials, then walks the exact path a
 * Claude.ai custom connector takes: metadata discovery -> dynamic client
 * registration -> authorize (login form) -> PKCE code exchange -> MCP
 * initialize/tools/ping -> refresh -> negative cases. The OAuth path runs
 * twice: as a public client and as a confidential one (client_secret_post,
 * which is how claude.ai registers).
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
// Spawn mode deletes and recreates its test user in the real database, so it
// never takes an identity from the environment: E2E_EMAIL/E2E_PASSWORD are
// the prod-smoke credentials of a REAL account.
const EMAIL = externalBase ? (process.env.E2E_EMAIL ?? "gate-a@test.local") : "gate-a@test.local";
// Spawn mode writes this account into the production database for the run,
// where the live server accepts it too: a password from this public repo
// would open it to anyone meanwhile (or after a run that died before cleanup).
const PASSWORD = externalBase ? (process.env.E2E_PASSWORD ?? "gate-a-secret") : randomBytes(18).toString("base64url");
const REDIRECT_URI = "http://localhost:19999/callback";
/** Short refresh-reuse grace for the spawned server, so expiry is testable. */
const E2E_REFRESH_GRACE_MS = 1500;
/**
 * How long a repeated sign-in form waits for the client to redeem the first
 * one's code. The production default: a redemption here is several round
 * trips to the remote database and must land inside it.
 */
const E2E_SIGN_IN_REPEAT_WAIT_MS = 4000;

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
/** OAuth clients this run registered; spawn mode deletes them on exit. */
const createdClients: string[] = [];
/** Spawn-mode test user, to prove delete_all_data leaves nothing keyed to it. */
let testUserId = "";
let zenStub: { stop: (closeActiveConnections?: boolean) => void } | null = null;
let ebStub: { stop: (closeActiveConnections?: boolean) => void } | null = null;

const ZEN_PORT = 8791;
const ZEN_TOKEN = "zen-e2e-token-0123456789";
const EB_PORT = 8792;
const MAIL_PORT = 8793;
/** Every email the spawned server sent (Resend stub): sign-in codes and signup notices. */
const sentMail: Array<{ to: string; subject: string; text: string }> = [];
let mailStub: { stop: (closeActiveConnections?: boolean) => void } | null = null;
/** Users this run created besides the gate-a test user; spawn mode deletes them on exit. */
const createdUserEmails: string[] = [];

function startMailStub() {
  return Bun.serve({
    port: MAIL_PORT,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/emails" || req.method !== "POST") return new Response("not found", { status: 404 });
      const body = (await req.json()) as { to: string[]; subject: string; text: string };
      sentMail.push({ to: body.to[0] ?? "", subject: body.subject, text: body.text });
      return Response.json({ id: `e2e-mail-${sentMail.length}` });
    },
  });
}
/** USD credit of the EB cross-currency pair, derived from the cached real rate (main). */
let ebFxCredit = "0.00";

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
 * transactions, one cross-account transfer pair, one cross-CURRENCY pair
 * (EUR debit + USD credit, FX-tolerance matched), one pending row.
 */
let ebCodesIssued = 0;
const ebCodesUsed = new Set<string>();

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
        return Response.json({ url: `${body.redirect_url}?code=e2e-eb-code-${++ebCodesIssued}&state=${body.state}` });
      }
      if (url.pathname === "/sessions" && req.method === "POST") {
        const body = (await req.json()) as { code: string };
        // A bank's authorization code works once, as at a real bank
        if (!body.code.startsWith("e2e-eb-code-") || ebCodesUsed.has(body.code)) return new Response("bad code", { status: 400 });
        ebCodesUsed.add(body.code);
        await Bun.sleep(150); // a real session call takes a moment: room for a double click
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
            { entry_reference: "ref-fx-1", transaction_amount: eur("100.00"), credit_debit_indicator: "DBIT", status: "BOOK", booking_date: "2026-07-14", remittance_information: ["Exchanged to USD"] },
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
        return Response.json({
          transactions: [
            // 100 EUR at the day's rate + 1%: within the 2% pairing tolerance
            // (banks apply their own FX spread).
            { entry_reference: "ref-fx-2", transaction_amount: { currency: "USD", amount: ebFxCredit }, credit_debit_indicator: "CRDT", status: "BOOK", booking_date: "2026-07-14", remittance_information: ["Exchanged from EUR"] },
          ],
        });
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
    if (!EMAIL.endsWith("@test.local")) throw new Error(`refusing to wipe non-test user ${EMAIL}`);
    const { db } = await import("../src/db");
    await db.user.deleteMany({ where: { email: EMAIL } });
    // The cross-currency pairing fixture needs the real EUR->USD rate of its
    // date: fx_rates is the shared production cache, so a fixture rate must
    // never be written into it. The stub's USD credit is that rate + 1%,
    // inside the 2% pairing tolerance banks' FX spreads need.
    const { convert } = await import("../src/fx");
    const fxEurUsd = await convert(100, "EUR", "USD", new Date("2026-07-14T00:00:00.000Z"));
    ebFxCredit = (Math.round(fxEurUsd.converted * 1.01 * 100) / 100).toFixed(2);
    const hash = await Bun.password.hash(PASSWORD);
    zenStub = startZenStub();
    ebStub = startEbStub();
    mailStub = startMailStub();
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
        REFRESH_REUSE_GRACE_MS: String(E2E_REFRESH_GRACE_MS),
        SIGN_IN_REPEAT_WAIT_MS: String(E2E_SIGN_IN_REPEAT_WAIT_MS),
        EB_APP_ID: "e2e-eb-app",
        EB_PRIVATE_KEY_B64: Buffer.from(ebKey).toString("base64"),
        EB_API_ORIGIN: `http://localhost:${EB_PORT}`,
        // Email sign-in on, every mail to the local stub; no real alert leaves
        // the run (signup notices would reach Telegram).
        RESEND_API_KEY: "e2e-resend-key",
        RESEND_API_BASE: `http://localhost:${MAIL_PORT}`,
        FROM_EMAIL: "noreply@test.local",
        NOTIFY_EMAIL: "ops@test.local",
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_CHAT_ID: "",
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

  const form = (url: string, params: Record<string, string>) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
  const tokenPost = (params: Record<string, string>) => form(asMeta.token_endpoint, params);
  const oauthError = async (res: Response) => ((await res.json()) as { error?: string }).error;
  // /authorize binds the sign-in to the browser (mf_bid cookie); the login
  // POST and the Google leg must send it back, as a browser does.
  const browserCookie = (res: Response): string =>
    res.headers.getSetCookie().find((c) => c.startsWith("mf_bid="))?.split(";")[0] ?? "";
  // `ip`: a failure check of its own address, so the failed sign-ins it
  // counts never lock the run's real sign-ins out (5 per 15 minutes per IP).
  const loginPost = (requestId: string, password: string, cookie: string, ip?: string) =>
    fetch(`${BASE}/login`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie ? { cookie } : {}),
        ...(ip ? { "x-forwarded-for": ip } : {}),
      },
      body: new URLSearchParams({ request_id: requestId, email: EMAIL, password }),
      redirect: "manual",
    });
  const register = async (clientName: string, authMethod: "none" | "client_secret_post") => {
    const res = await fetch(asMeta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: authMethod,
      }),
    });
    const json: any = await res.json();
    if (json.client_id) createdClients.push(json.client_id);
    return { status: res.status, json };
  };

  // 2. Dynamic client registration
  const { status: regStatus, json: client } = await register("Gate A e2e", "none");
  ok("dynamic registration", regStatus === 201 && !!client.client_id, JSON.stringify(client));
  // Registration is anonymous and permanent: oversized metadata is refused
  const { status: bigNameStatus, json: bigName } = await register("x".repeat(5000), "none");
  ok(
    "registration with a 5000-char client_name -> 400",
    bigNameStatus === 400 && bigName.error === "invalid_client_metadata",
    JSON.stringify({ status: bigNameStatus, error: bigName.error })
  );

  // 2b. Confidential client, registered the way claude.ai does it
  // (client_secret_post). The secret must never expire (the SDK's 30-day
  // default killed every claude.ai connector on day 31, 2026-09-24), it must
  // really be checked, refusals must leave a trace, and the whole flow must
  // work with it. Spawn mode only: writes to the DB.
  if (!externalBase) {
    const { status: confStatus, json: conf } = await register("Gate A e2e confidential", "client_secret_post");
    ok(
      "confidential client secret never expires",
      confStatus === 201 && !!conf.client_secret && conf.client_secret_expires_at === 0,
      JSON.stringify({ status: confStatus, expires: conf.client_secret_expires_at })
    );
    const auth = { client_id: conf.client_id, client_secret: conf.client_secret };
    const fakeRefresh = { grant_type: "refresh_token", refresh_token: "e2e-not-a-real-token" };
    // invalid_grant = client auth passed and the (fake) grant was judged
    ok("right secret passes client auth", (await oauthError(await tokenPost({ ...fakeRefresh, ...auth }))) === "invalid_grant");
    ok(
      "wrong secret -> invalid_client",
      (await oauthError(await tokenPost({ ...fakeRefresh, ...auth, client_secret: "wrong" }))) === "invalid_client"
    );
    ok(
      "missing secret -> invalid_client",
      (await oauthError(await tokenPost({ ...fakeRefresh, client_id: conf.client_id }))) === "invalid_client"
    );
    const { db: cdb } = await import("../src/db");
    const refusalWhere = {
      type: "oauth_error",
      AND: [
        { meta: { path: ["client_id"], equals: conf.client_id } },
        { meta: { path: ["error"], equals: "invalid_client" } },
      ],
    };
    let refusals = 0;
    for (let i = 0; i < 30 && refusals < 2; i++) {
      await Bun.sleep(100); // logEvent is fire-and-forget
      refusals = await cdb.event.count({ where: refusalWhere });
    }
    ok("client refusals logged as oauth_error events", refusals === 2, `found ${refusals}`);

    // Full flow with the secret: code exchange, refresh rotation, revocation
    const signIn = async () => {
      const verifier = b64url(randomBytes(48));
      const url = new URL(asMeta.authorization_endpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", conf.client_id);
      url.searchParams.set("redirect_uri", REDIRECT_URI);
      url.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
      url.searchParams.set("code_challenge_method", "S256");
      const authRes = await fetch(url);
      const browser = browserCookie(authRes);
      const rid = (await authRes.text()).match(/name="request_id" value="([^"]+)"/)?.[1] ?? "";
      const login = await loginPost(rid, PASSWORD, browser);
      const code = new URL(login.headers.get("location") ?? "http://invalid/").searchParams.get("code") ?? "";
      const res = await tokenPost({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT_URI, ...auth });
      return { login, code, res, tok: (await res.json()) as any };
    };
    const refreshWith = (refresh_token: string) => tokenPost({ grant_type: "refresh_token", refresh_token, ...auth });
    const pingWith = async (token: string) =>
      (await mcpCall(token, { jsonrpc: "2.0", id: 90, method: "tools/call", params: { name: "ping", arguments: {} } })).status;

    const first = await signIn();
    ok("confidential: login redirects with code", first.login.status === 302 && !!first.code);
    const confTok = first.tok;
    ok("confidential: code + secret -> tokens", first.res.status === 200 && !!confTok.refresh_token, JSON.stringify(confTok));
    // Tokens are stored as their sha256, never as the bearer value
    const keyOf = (v: string) => createHash("sha256").update(v).digest("hex");
    const [rawRows, hashedRows] = await Promise.all([
      cdb.oauthRefreshToken.count({ where: { token: { in: [confTok.refresh_token, confTok.access_token] } } }),
      cdb.oauthRefreshToken.count({ where: { token: keyOf(confTok.refresh_token), grantId: { not: null }, grantIssuedAt: { not: null } } }),
    ]);
    const rawAccess = await cdb.oauthAccessToken.count({ where: { token: confTok.access_token } });
    ok(
      "tokens stored hashed, refresh token carries its grant",
      rawRows === 0 && rawAccess === 0 && hashedRows === 1,
      JSON.stringify({ rawRows, rawAccess, hashedRows })
    );
    const confRefRes = await refreshWith(confTok.refresh_token);
    const confRef: any = await confRefRes.json();
    ok(
      "confidential: refresh with secret rotates",
      confRefRes.status === 200 && !!confRef.refresh_token && confRef.refresh_token !== confTok.refresh_token,
      JSON.stringify({ status: confRefRes.status, error: confRef.error })
    );
    ok("confidential: refreshed access token works", (await pingWith(confRef.access_token)) === 200);
    const grantOf = async (refresh: string) =>
      (await cdb.oauthRefreshToken.findUnique({ where: { token: keyOf(refresh) } }))?.grantId ?? null;
    ok(
      "rotation keeps the grant",
      !!(await grantOf(confRef.refresh_token)) && (await grantOf(confRef.refresh_token)) === (await grantOf(confTok.refresh_token))
    );

    // A grant cannot be refreshed past a year after its sign-in
    await cdb.oauthRefreshToken.update({
      where: { token: keyOf(confRef.refresh_token) },
      data: { grantIssuedAt: new Date(Date.now() - 366 * 86_400_000) },
    });
    const tooOld = await refreshWith(confRef.refresh_token);
    ok("refresh of a year-old grant -> invalid_grant", tooOld.status === 400 && (await oauthError(tooOld)) === "invalid_grant");

    // Revoking the refresh token ends the grant: its access token dies too
    const revRes = await form(asMeta.revocation_endpoint, { token: confRef.refresh_token, ...auth });
    ok("confidential: revoke with secret", revRes.status === 200);
    ok("revoked refresh token refused", (await oauthError(await refreshWith(confRef.refresh_token))) === "invalid_grant");
    ok("revoking the refresh token revokes its access token", (await pingWith(confRef.access_token)) === 401);

    // Replay: a rotated token presented after the grace window means a copy
    // is out there, so the whole grant goes, the thief's successor included
    const second = await signIn();
    const victim = second.tok;
    const rotated: any = await (await refreshWith(victim.refresh_token)).json();
    ok("second sign-in rotates", !!rotated.refresh_token, JSON.stringify(rotated));
    await Bun.sleep(E2E_REFRESH_GRACE_MS + 300);
    const replay = await refreshWith(victim.refresh_token);
    ok("replayed refresh token -> invalid_grant", replay.status === 400 && (await oauthError(replay)) === "invalid_grant");
    ok("replay revokes the successor refresh token", (await oauthError(await refreshWith(rotated.refresh_token))) === "invalid_grant");
    ok("replay revokes the successor access token", (await pingWith(rotated.access_token)) === 401);
    let replays = 0;
    for (let i = 0; i < 30 && replays < 1; i++) {
      await Bun.sleep(100); // logEvent is fire-and-forget
      replays = await cdb.event.count({
        where: { type: "oauth_refresh_replay", meta: { path: ["client_id"], equals: conf.client_id } },
      });
    }
    ok("replay logged as an oauth_refresh_replay event", replays === 1, `found ${replays}`);

    // Idle registrations: no live token or code and over 30 days old -> gone;
    // a client holding a live refresh token is never touched
    const { OAuthStore } = await import("../src/oauth/store");
    const { json: idle } = await register("Gate A e2e idle", "none");
    const third = await signIn();
    ok("third sign-in for the prune check", third.res.status === 200);
    const monthAgo = new Date(Date.now() - 31 * 86_400_000);
    await cdb.oauthClient.updateMany({ where: { clientId: { in: [idle.client_id, conf.client_id] } }, data: { createdAt: monthAgo } });
    await new OAuthStore().pruneIdleClients();
    const left = await cdb.oauthClient.findMany({ where: { clientId: { in: [idle.client_id, conf.client_id] } }, select: { clientId: true } });
    ok(
      "idle client pruned, client with a live grant kept",
      left.length === 1 && left[0]!.clientId === conf.client_id,
      JSON.stringify(left)
    );
    const goneUrl = new URL(asMeta.authorization_endpoint);
    goneUrl.searchParams.set("response_type", "code");
    goneUrl.searchParams.set("client_id", idle.client_id);
    goneUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    goneUrl.searchParams.set("code_challenge", b64url(randomBytes(32)));
    goneUrl.searchParams.set("code_challenge_method", "S256");
    const gone = await fetch(goneUrl, { redirect: "manual" });
    ok(
      "pruned client at /authorize -> 400 page that says what to do",
      gone.status === 400 && (await gone.text()).includes("no longer registered"),
      String(gone.status)
    );
    await form(asMeta.revocation_endpoint, { token: third.tok.refresh_token, ...auth });

    // A row registered before 2026-09-27 carries the SDK's 30-day default
    // stamp (issued 31 days ago, so expired yesterday): it must keep working.
    const legacyIssued = Math.floor(Date.now() / 1000) - 31 * 86_400;
    await cdb.oauthClient.update({
      where: { clientId: conf.client_id },
      data: { data: { ...conf, client_id_issued_at: legacyIssued, client_secret_expires_at: legacyIssued + 30 * 86_400 } },
    });
    ok(
      "legacy 30-day default stamp still passes client auth",
      (await oauthError(await tokenPost({ ...fakeRefresh, ...auth }))) === "invalid_grant"
    );
    // Any other past expiry on the row is enforced: that is how a leaked
    // client gets cut off.
    await cdb.oauthClient.update({
      where: { clientId: conf.client_id },
      data: { data: { ...conf, client_secret_expires_at: Math.floor(Date.now() / 1000) - 60 } },
    });
    ok(
      "stored past secret expiry is enforced",
      (await oauthError(await tokenPost({ ...fakeRefresh, ...auth }))) === "invalid_client"
    );
  }

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
  const cookie = browserCookie(authRes);
  const authHtml = await authRes.text();
  const requestId = authHtml.match(/name="request_id" value="([^"]+)"/)?.[1];
  ok("authorize renders login form", authRes.status === 200 && !!requestId);
  ok("authorize sets the browser-binding cookie", cookie.length > "mf_bid=".length);
  // The page names where the code goes, not just the self-chosen client_name
  ok(
    "login page shows the redirect destination",
    authHtml.includes("After sign-in you return to <b>an app on this device</b>")
  );

  // 3a. Malformed or foreign authorization requests get a 400 page, never a
  // redirect to the (anonymously registered) redirect_uri.
  const badAuthorize = async (patch: Record<string, string>) => {
    const url = new URL(authUrl);
    for (const [k, v] of Object.entries(patch)) url.searchParams.set(k, v);
    const res = await fetch(url, { redirect: "manual" });
    return {
      status: res.status,
      location: res.headers.get("location") ?? "",
      type: res.headers.get("content-type") ?? "",
      html: await res.text(),
    };
  };
  const implicit = await badAuthorize({ response_type: "token" });
  ok(
    "authorize response_type=token -> 400 page, no redirect",
    implicit.status === 400 && !implicit.location && implicit.type.includes("text/html"),
    JSON.stringify({ status: implicit.status, location: implicit.location })
  );
  const foreign = await badAuthorize({ resource: "https://evil.example/mcp" });
  ok(
    "authorize with a foreign resource -> invalid_target",
    (foreign.status === 400 && foreign.html.includes("invalid_target")) ||
      (foreign.status === 302 && foreign.location.includes("error=invalid_target")),
    JSON.stringify({ status: foreign.status, location: foreign.location })
  );

  // 3b. Google sign-in wiring
  if (!externalBase) {
    ok("login page offers Google", authHtml.includes(`/auth/google?request_id=`));
    const gNoCookie = await fetch(`${BASE}/auth/google?request_id=${requestId}`, { redirect: "manual" });
    ok("google start without the browser cookie -> 400", gNoCookie.status === 400);
    const gStart = await fetch(`${BASE}/auth/google?request_id=${requestId}`, { redirect: "manual", headers: { cookie } });
    const gLoc = gStart.headers.get("location") ?? "";
    ok(
      "google start -> 302 to accounts.google.com",
      gStart.status === 302 && gLoc.startsWith("https://accounts.google.com/o/oauth2/v2/auth")
    );
    ok("google start carries state + client_id", /[?&]state=/.test(gLoc) && gLoc.includes("client_id="));
    const gState = new URL(gLoc || "http://invalid/").searchParams.get("state") ?? "";
    const googleCallback = (withCookie: string) =>
      fetch(`${BASE}/auth/google/callback?state=${gState}&code=e2e-google-code`, {
        redirect: "manual",
        headers: withCookie ? { cookie: withCookie } : {},
      });
    const gOther = await googleCallback("");
    ok("google callback from another browser -> 400, the state is spent", gOther.status === 400 && (await gOther.text()).includes("different browser"));
    const gAgain = await googleCallback(cookie);
    const gAgainHtml = await gAgain.text();
    ok(
      "a spent google state is never exchanged again: the sign-in form comes back",
      gAgain.status === 400 && gAgainHtml.includes("did not complete") && gAgainHtml.includes(`value="${requestId}"`)
    );
  }
  // 3c. Email sign-in: a 6-digit code by email, bound to this browser and
  // this sign-in; the first verified sign-in creates the account. An account
  // linked to Google gets a pointer to Google instead of a code.
  if (!externalBase) {
    ok("login page offers email sign-in", authHtml.includes('action="/login/email"'));
    const { db: mdb } = await import("../src/db");
    const startSignIn = async () => {
      const res = await fetch(authUrl);
      const browser = browserCookie(res);
      const rid = (await res.text()).match(/name="request_id" value="([^"]+)"/)?.[1] ?? "";
      return { rid, browser };
    };
    const postForm = (path: string, params: Record<string, string>, cookie: string, ip?: string) =>
      fetch(`${BASE}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(cookie ? { cookie } : {}),
          ...(ip ? { "x-forwarded-for": ip } : {}),
        },
        body: new URLSearchParams(params),
        redirect: "manual",
      });
    const mailTo = (to: string) => sentMail.filter((m) => m.to === to);

    const newcomer = `gate-a-mail-${randomBytes(4).toString("hex")}@test.local`;
    createdUserEmails.push(newcomer);
    const si = await startSignIn();
    ok("email code without the browser cookie -> 400", (await postForm("/login/email", { request_id: si.rid, email: newcomer }, "")).status === 400);
    ok("email code for a malformed address -> 400", (await postForm("/login/email", { request_id: si.rid, email: "not-an-email" }, si.browser)).status === 400);
    const sendRes = await postForm("/login/email", { request_id: si.rid, email: newcomer }, si.browser);
    const sendHtml = await sendRes.text();
    const codeMail = mailTo(newcomer).at(-1);
    const emailCode = codeMail?.subject.match(/^(\d{8}) is your MyFinance sign-in code$/)?.[1] ?? "";
    ok(
      "email code sent, page names the masked address",
      sendRes.status === 200 && sendHtml.includes("ga•••@test.local") && !!emailCode && !!codeMail?.text.includes(emailCode),
      JSON.stringify({ status: sendRes.status, subject: codeMail?.subject })
    );
    ok("code email names where the code connects", !!codeMail?.text.includes("connects MyFinance to an app on this device"));
    const wrong = await postForm(
      "/login/email/verify",
      { request_id: si.rid, code: emailCode === "00000000" ? "00000001" : "00000000" },
      si.browser,
      "10.78.0.3"
    );
    ok("wrong email code -> 401", wrong.status === 401 && (await wrong.text()).includes("Wrong code"));
    ok(
      "email code from another browser -> 400",
      (await postForm("/login/email/verify", { request_id: si.rid, code: emailCode }, "")).status === 400
    );
    const verified = await postForm("/login/email/verify", { request_id: si.rid, code: emailCode }, si.browser);
    const emailCodeGrant = new URL(verified.headers.get("location") ?? "http://invalid/").searchParams.get("code") ?? "";
    ok("right email code -> redirect with code", verified.status === 302 && !!emailCodeGrant, String(verified.status));
    // A second tap while the redirect is loading: the repeat waits, the client
    // redeems meanwhile, and the repeat is told so. It never gets a code.
    const [verifiedAgain, emailTokRes] = await Promise.all([
      postForm("/login/email/verify", { request_id: si.rid, code: emailCode }, si.browser),
      Bun.sleep(150).then(() =>
        tokenPost({
          grant_type: "authorization_code",
          code: emailCodeGrant,
          code_verifier: verifier,
          client_id: client.client_id,
          redirect_uri: REDIRECT_URI,
        })
      ),
    ]);
    ok(
      "a repeated code while the client redeems -> connected page, no code",
      verifiedAgain.status === 200 &&
        !verifiedAgain.headers.get("location") &&
        (await verifiedAgain.text()).includes("Connected. You can close this tab")
    );
    const otherCode = await postForm(
      "/login/email/verify",
      { request_id: si.rid, code: emailCode === "00000000" ? "00000001" : "00000000" },
      si.browser,
      "10.78.0.1"
    );
    ok(
      "another code on a finished sign-in -> refused, no code",
      otherCode.status === 400 && !otherCode.headers.get("location") && (await otherCode.text()).includes("Wrong code")
    );
    const emailTok: any = await emailTokRes.json();
    const emailPing = await mcpCall(emailTok.access_token ?? "", {
      jsonrpc: "2.0",
      id: 95,
      method: "tools/call",
      params: { name: "ping", arguments: {} },
    });
    ok(
      "email sign-in creates the account and connects it",
      JSON.parse(emailPing.json?.result?.content?.[0]?.text ?? "{}").user === newcomer,
      JSON.stringify(emailPing.json).slice(0, 200)
    );
    let notice = false;
    for (let i = 0; i < 30 && !notice; i++) {
      await Bun.sleep(100); // notifySignup is fire-and-forget
      notice = sentMail.some((m) => m.to === "ops@test.local" && m.subject.includes(newcomer));
    }
    ok("email signup sends the signup notice", notice);
    await form(asMeta.revocation_endpoint, { token: emailTok.refresh_token ?? "", client_id: client.client_id });

    // An account that signs in with Google: never a code, same page
    const googler = `gate-a-google-${randomBytes(4).toString("hex")}@test.local`;
    createdUserEmails.push(googler);
    await mdb.user.create({ data: { email: googler, googleSub: `e2e-sub-${randomBytes(4).toString("hex")}` } });
    const sg = await startSignIn();
    const gSend = await postForm("/login/email", { request_id: sg.rid, email: googler }, sg.browser);
    ok(
      "Google-linked address gets a pointer to Google, not a code",
      gSend.status === 200 && mailTo(googler).at(-1)?.subject === "Sign in to MyFinance with Google" &&
        !/\d{6}/.test(mailTo(googler).at(-1)?.text ?? ""),
      JSON.stringify(mailTo(googler).at(-1))
    );
    // The operator account has a password: the mailbox alone must not open it
    const sp = await startSignIn();
    const pSend = await postForm("/login/email", { request_id: sp.rid, email: EMAIL }, sp.browser);
    ok(
      "password account gets a pointer to its password, not a code",
      pSend.status === 200 && mailTo(EMAIL).at(-1)?.subject === "Sign in to MyFinance with your password" &&
        !/\d{6}/.test(mailTo(EMAIL).at(-1)?.text ?? ""),
      JSON.stringify(mailTo(EMAIL).at(-1))
    );

    // Wrong codes are budgeted per address across resends and IPs: attackers
    // on many IPs cannot buy fresh guesses with a new code
    const grind = `gate-a-grind-${randomBytes(4).toString("hex")}@test.local`;
    createdUserEmails.push(grind);
    const sgr = await startSignIn();
    const fromIp = (n: number, path: string, params: Record<string, string>) =>
      fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: sgr.browser, "x-forwarded-for": `10.77.0.${n}` },
        body: new URLSearchParams({ request_id: sgr.rid, ...params }),
        redirect: "manual",
      });
    let lastWrong = "";
    for (let i = 0; i < 10; i++) {
      if (i % 5 === 0) await fromIp(100 + i, "/login/email", { email: grind }); // a fresh code every 5 tries
      const real = mailTo(grind).at(-1)?.subject.slice(0, 8) ?? "";
      lastWrong = await (await fromIp(i + 1, "/login/email/verify", { code: real === "00000000" ? "00000001" : "00000000" })).text();
    }
    ok("10th wrong code for one address locks it, across resends and IPs", lastWrong.includes("Too many wrong codes for this address"));
    ok(
      "locked address gets no new code",
      (await fromIp(200, "/login/email", { email: grind })).status === 429 && mailTo(grind).length === 2,
      String(mailTo(grind).length)
    );

    // A second tap on "Email me a sign-in code": one email, and both pages
    // ask for that email's code (a second send would void it).
    // (Sends here come from addresses of their own: the run's default one
    // carries 10 code sends an hour.)
    const sendIp = "10.78.1.1";
    const twiceMail = `gate-a-twice-${randomBytes(4).toString("hex")}@test.local`;
    const st = await startSignIn();
    const doubleTap = async (s: { rid: string; browser: string }, address: string) => {
      const both = await Promise.all([
        postForm("/login/email", { request_id: s.rid, email: address }, s.browser, sendIp),
        postForm("/login/email", { request_id: s.rid, email: address }, s.browser, sendIp),
      ]);
      const pages = await Promise.all(both.map((r) => r.text()));
      return { statuses: both.map((r) => r.status), codePages: pages.every((t) => t.includes('action="/login/email/verify"')) };
    };
    const twoSends = await doubleTap(st, twiceMail);
    ok(
      "two overlapping code requests -> one email, both pages ask for its code",
      mailTo(twiceMail).length === 1 && twoSends.statuses.every((s) => s === 200) && twoSends.codePages,
      JSON.stringify({ mails: mailTo(twiceMail).length, ...twoSends })
    );
    const correctedMail = `gate-a-corrected-${randomBytes(4).toString("hex")}@test.local`;
    const corrected = await postForm("/login/email", { request_id: st.rid, email: correctedMail }, st.browser, sendIp);
    ok("a corrected address right after a send -> mailed", corrected.status === 200 && mailTo(correctedMail).length === 1);
    // At the address's last send, a double tap still ends on the code page
    const capMail = `gate-a-cap-${randomBytes(4).toString("hex")}@test.local`;
    for (let i = 0; i < 2; i++) {
      const s = await startSignIn();
      await postForm("/login/email", { request_id: s.rid, email: capMail }, s.browser, sendIp);
    }
    const atCap = await doubleTap(await startSignIn(), capMail);
    ok(
      "a double tap on the address's last send -> both pages ask for its code",
      mailTo(capMail).length === 3 && atCap.statuses.every((s) => s === 200) && atCap.codePages,
      JSON.stringify({ mails: mailTo(capMail).length, ...atCap })
    );

    // Sends per address are capped across sign-ins: two more pass, the fourth
    // is refused. (Within one sign-in a quick resend repeats the last send.)
    const sendFresh = async () => {
      const s = await startSignIn();
      return postForm("/login/email", { request_id: s.rid, email: googler }, s.browser);
    };
    await sendFresh();
    await sendFresh();
    ok("fourth code for one address in 15 min -> 429", (await sendFresh()).status === 429);
  }

  // Enabled -> 400 (bad request), not configured -> 404; both prove routing works.
  const gBadReq = await fetch(`${BASE}/auth/google?request_id=bogus`, { redirect: "manual" });
  ok("google start with bogus request rejected", gBadReq.status === 400 || gBadReq.status === 404);
  const gBadState = await fetch(`${BASE}/auth/google/callback?state=bogus&code=x`, { redirect: "manual" });
  ok("google callback with bogus state rejected", gBadState.status === 400 || gBadState.status === 404);

  // 4. Wrong password rejected; the right one from another browser too
  const badLogin = await loginPost(requestId!, "wrong", cookie);
  ok("wrong password -> 401", badLogin.status === 401);
  const otherBrowser = await loginPost(requestId!, PASSWORD, "");
  ok(
    "login without the browser cookie -> 400",
    otherBrowser.status === 400 && (await otherBrowser.text()).includes("different browser")
  );

  // 5. Login -> code
  const login = await loginPost(requestId!, PASSWORD, cookie);
  const location = login.headers.get("location") ?? "";
  const cbUrl = new URL(location);
  const code = cbUrl.searchParams.get("code");
  ok("login redirects with code", login.status === 302 && !!code);
  ok("state round-trip", cbUrl.searchParams.get("state") === "e2e-state-123");
  // The form can arrive twice: a second tap while the redirect is loading, or
  // a reload. A repeat is told how the first one ended and never gets a code.
  const repeated = await loginPost(requestId!, PASSWORD, cookie);
  ok(
    "a repeat before the client redeemed -> already sent, no code",
    repeated.status === 200 && !repeated.headers.get("location") && (await repeated.text()).includes("already sent to")
  );
  const repeatedElsewhere = await loginPost(requestId!, PASSWORD, "");
  ok(
    "the same repeat from another browser -> expired",
    repeatedElsewhere.status === 400 && (await repeatedElsewhere.text()).includes("expired")
  );
  const twiceRes = await fetch(authUrl);
  const twiceCookie = browserCookie(twiceRes);
  const twiceRid = (await twiceRes.text()).match(/name="request_id" value="([^"]+)"/)?.[1] ?? "";
  // The first answer is the sign-in; its code is redeemed at once, as a
  // client does, so the second one, queued behind it, hears "Connected".
  const overlappingSent = [loginPost(twiceRid, PASSWORD, twiceCookie), loginPost(twiceRid, PASSWORD, twiceCookie)];
  const firstAnswer = await Promise.race(overlappingSent);
  const twiceCode = new URL(firstAnswer.headers.get("location") ?? "http://invalid/").searchParams.get("code") ?? "";
  const twiceTok: any = await (
    await tokenPost({ grant_type: "authorization_code", code: twiceCode, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT_URI })
  ).json();
  const overlapping = await Promise.all(overlappingSent);
  const queuedPage = await (overlapping.find((r) => r.status === 200) ?? overlapping[1]!).text();
  // Revoked before the check: a failed check must not leave a live grant
  // behind for the real account of a production smoke run.
  await form(asMeta.revocation_endpoint, { token: twiceTok.refresh_token ?? "", client_id: client.client_id });
  ok(
    "two overlapping sign-in POSTs -> one code, the queued one says connected",
    overlapping.filter((r) => r.status === 302 && !!r.headers.get("location")).length === 1 &&
      overlapping.filter((r) => r.status === 200).length === 1 &&
      queuedPage.includes("Connected. You can close this tab") &&
      !!twiceTok.access_token,
    JSON.stringify(overlapping.map((r) => r.status))
  );

  // 6. Token exchange with wrong verifier rejected
  const badToken = await tokenPost({
    grant_type: "authorization_code",
    code: code!,
    code_verifier: b64url(randomBytes(48)),
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
  });
  ok("wrong PKCE verifier rejected", badToken.status === 400);

  // 7. Token exchange, sent twice at once: the code is consumed atomically,
  // so exactly one of two concurrent redemptions gets tokens
  const codeExchange = {
    grant_type: "authorization_code",
    code: code!,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
  };
  const exchanges = await Promise.all([tokenPost(codeExchange), tokenPost(codeExchange)]);
  ok(
    "concurrent double redemption: exactly one 200",
    exchanges.filter((r) => r.status === 200).length === 1,
    JSON.stringify(exchanges.map((r) => r.status))
  );
  const tokenRes = exchanges.find((r) => r.status === 200) ?? exchanges[0]!;
  const tokens: any = await tokenRes.json();
  ok(
    "code -> tokens",
    tokenRes.status === 200 && !!tokens.access_token && !!tokens.refresh_token,
    JSON.stringify(tokens)
  );

  // 8. Code is single-use
  const replay = await tokenPost(codeExchange);
  ok("code replay rejected", replay.status === 400);
  const repeatedLater = await loginPost(requestId!, PASSWORD, cookie);
  const repeatedLaterHtml = await repeatedLater.text();
  ok(
    "a repeat after the client redeemed -> connected page, no form, no code",
    repeatedLater.status === 200 &&
      !repeatedLater.headers.get("location") &&
      repeatedLaterHtml.includes("Connected. You can close this tab") &&
      !repeatedLaterHtml.includes("<form")
  );
  // Other buttons left on a finished sign-in's page: "Use a different email",
  // "Send a new code", "Continue with Google".
  const finishedPages = await Promise.all([
    fetch(`${BASE}/login?request_id=${requestId}`, { headers: { cookie } }),
    fetch(`${BASE}/login/email`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ request_id: requestId!, email: EMAIL }),
      redirect: "manual",
    }),
    fetch(`${BASE}/auth/google?request_id=${requestId}`, { headers: { cookie }, redirect: "manual" }),
  ]);
  const finishedHtml = await Promise.all(finishedPages.map((r) => r.text()));
  ok(
    "other buttons on a finished sign-in's page -> already finished, no form",
    finishedPages.every((r) => r.status === 200) && finishedHtml.every((t) => t.includes("already finished") && !t.includes("<form")),
    JSON.stringify(finishedPages.map((r) => r.status))
  );
  if (!externalBase) {
    // Counts as a failed sign-in, so it stays off the production smoke run.
    const repeatedOtherPassword = await loginPost(requestId!, "not-the-password", cookie, "10.78.0.2");
    ok(
      "a repeat with a wrong password -> says so, no code",
      repeatedOtherPassword.status === 400 &&
        !repeatedOtherPassword.headers.get("location") &&
        (await repeatedOtherPassword.text()).includes("Wrong email or password")
    );
  }

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

    // 12f. A hand-logged transfer between two OTHER accounts is not the twin of a
    // statement row on a third account (Wise -> Mono EUR -> Mono UAH hops, 2026-09-07).
    await call("create_account", { name: "Twin Wise", type: "bank", currency: "RON" });
    await call("log_transfer", { amount: 77.77, from_account: "Revolut", to_account: "IBKR", received_amount: 15, received_currency: "USD", note: "hop-elsewhere" });
    const impHop = payload(
      await call("import_transactions", {
        account: "Twin Wise",
        transactions: [{ date: today(), amount: -77.77, currency: "RON", type: "transfer", external_id: "TRANSFER-hop-1" }],
      })
    );
    ok(
      "import: transfer between two other accounts is NOT merged as a twin",
      impHop.imported === 1 && impHop.manual_twins_merged === 0,
      JSON.stringify(impHop)
    );
    const hopRow = payload(await call("get_transactions", { query: "hop-elsewhere" })).transactions?.[0];
    ok("import: the other transfer stays on its own account", hopRow?.account === "Revolut", JSON.stringify(hopRow));
    // Receiving leg: statement of the DESTINATION account confirms a hand-logged transfer
    // into it - the row keeps its source account, only the counter key is stamped.
    await call("log_transfer", { amount: 55.55, from_account: "Twin Wise", to_account: "Revolut", note: "twin-leg-in" });
    const impLeg = payload(
      await call("import_transactions", {
        account: "Revolut",
        transactions: [{ date: today(), amount: 55.55, currency: "RON", external_id: "TOPUP-leg-1" }],
      })
    );
    ok("import: receiving leg merges into the hand-logged transfer", impLeg.manual_twins_merged === 1 && impLeg.imported === 0, JSON.stringify(impLeg));
    const legRow = payload(await call("get_transactions", { query: "twin-leg-in" })).transactions?.[0];
    ok("import: merged receiving leg is not flipped onto its destination", legRow?.account === "Twin Wise", JSON.stringify(legRow));
    const impLegAgain = payload(
      await call("import_transactions", {
        account: "Revolut",
        transactions: [{ date: today(), amount: 55.55, currency: "RON", external_id: "TOPUP-leg-1" }],
      })
    );
    ok("import: receiving leg re-import is skipped by counter key", impLegAgain.imported === 0 && impLegAgain.skipped?.[0]?.reason === "merged_transfer_leg", JSON.stringify(impLegAgain));

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
      csvText.split("\n")[0]!.includes(",entity,account,counter_account,") && csvText.includes(",business") && !csvText.includes(",personal"),
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
    testUserId = testUser.id;
    await odb.account.create({
      data: { userId: testUser.id, name: "Orphan Savings", type: "bank", provider: "enablebanking", externalId: "eb-acc-2", currency: "EUR" },
    });
    // The bank's return binds nothing: the page names the MyFinance account
    // that would get the access, and only a confirm from this browser binds.
    const bankLink = async (authorizeUrl: string) => {
      const page = await fetch(authorizeUrl);
      const html = await page.text();
      const cookie = page.headers.getSetCookie().find((c) => c.startsWith("mf_bank="))?.split(";")[0] ?? "";
      const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
      const confirm = (decision: string, withCookie = cookie) =>
        fetch(`${BASE}/connect/enablebanking/confirm`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", ...(withCookie ? { cookie: withCookie } : {}) },
          body: new URLSearchParams({ state, decision }),
        });
      return { page, html, cookie, confirm };
    };
    type Rec2 = Record<string, unknown>;
    const declined = await bankLink(ebStart.authorize_url);
    ok(
      "eb callback asks to confirm, naming the masked account",
      declined.page.status === 200 &&
        declined.html.includes("Connect Mock Bank to MyFinance?") &&
        declined.html.includes("ga•••@test.local") &&
        !!declined.cookie,
      declined.html.slice(0, 300)
    );
    ok("eb confirm from another browser -> 400", (await declined.confirm("connect", "")).status === 400);
    ok("nothing bound before the confirm", payload(await call("connect_bank", { action: "status" })).status === "pending");
    const cancelled = await declined.confirm("cancel");
    ok("eb cancel binds nothing", cancelled.status === 200 && (await cancelled.text()).includes("Not connected"));
    ok("cancelled link is dead", (await declined.confirm("connect")).status === 400);
    ok("connection left in error after cancel", payload(await call("connect_bank", { action: "status" })).status === "error");

    // The link's 30 minutes run from the start: a reload does not extend them
    const ebStale = payload(await call("connect_bank", { action: "start", country: "FI", bank_name: "Mock Bank" }));
    const staleRow = await odb.bankConnection.findFirstOrThrow({ where: { userId: testUser.id, provider: "enablebanking" } });
    await odb.bankConnection.update({
      where: { id: staleRow.id },
      data: { meta: { ...(staleRow.meta as object), startedAt: Date.now() - 31 * 60_000 } },
    });
    ok("eb link older than 30 minutes from its start -> expired", (await fetch(ebStale.authorize_url)).status === 400);

    const ebStart2 = payload(await call("connect_bank", { action: "start", country: "FI", bank_name: "Mock Bank" }));
    const accepted = await bankLink(ebStart2.authorize_url);
    const heldCode = new URL(ebStart2.authorize_url).searchParams.get("code") ?? "";
    const heldMeta = (await odb.bankConnection.findFirstOrThrow({ where: { userId: testUser.id, provider: "enablebanking" } })).meta as Rec2;
    ok(
      "bank code held for the confirm is encrypted",
      typeof heldMeta.pendingCode === "string" && !!heldCode && !String(heldMeta.pendingCode).includes(heldCode),
      JSON.stringify({ held: String(heldMeta.pendingCode).slice(0, 12) })
    );
    // A reload of the bank's return page keeps the held code (a confirm
    // already on its way still matches) and hands out a new browser key
    const reloaded = await bankLink(ebStart2.authorize_url);
    const reloadMeta = (await odb.bankConnection.findFirstOrThrow({ where: { userId: testUser.id, provider: "enablebanking" } })).meta as Rec2;
    ok(
      "reload keeps the held bank code and its clock",
      reloadMeta.pendingCode === heldMeta.pendingCode && reloadMeta.codeAt === heldMeta.codeAt && reloaded.cookie !== accepted.cookie
    );
    ok("old browser key refused after a reload", (await accepted.confirm("connect")).status === 400);
    // Double click: one confirm binds, the other finds the code taken and
    // cannot undo the connection with its failed bank call
    const [c1, c2] = await Promise.all([reloaded.confirm("connect"), reloaded.confirm("connect")]);
    const bodies = [await c1.text(), await c2.text()];
    ok(
      "double-clicked confirm connects exactly once",
      bodies.filter((b) => b.includes("Bank connected")).length === 1 && bodies.filter((b) => b.includes("already used")).length === 1,
      JSON.stringify([c1.status, c2.status])
    );
    ok("connection active after the double click", payload(await call("connect_bank", { action: "status" })).status === "active");
    ok("confirmed link cannot be confirmed again", (await reloaded.confirm("connect")).status === 400);

    const ebs1 = payload(await call("sync_bank", {}));
    ok("eb first sync counts", ebs1.accounts_created === 2 && ebs1.imported === 2 && ebs1.transfers === 2 && ebs1.manual_twins_merged === 1, JSON.stringify(ebs1));
    const fxTr = await odb.transaction.findFirst({ where: { userId: testUser.id, externalId: { endsWith: "ref-fx-1" } } });
    ok(
      "cross-currency pair -> one transfer",
      fxTr?.type === "transfer" &&
        Number(fxTr.amount) === 100 &&
        fxTr.currency === "EUR" &&
        Number(fxTr.counterAmount) === Number(ebFxCredit) &&
        fxTr.counterCurrency === "USD" &&
        !!fxTr.counterExternalId?.endsWith("ref-fx-2"),
      JSON.stringify(fxTr)
    );
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

    // 12eb2b. counter_transaction_id (0.13.0): glue two EXISTING rows into one
    // transfer (currency exchange booked as expense + income on two accounts).
    await call("create_account", { name: "USD Wallet", type: "bank", currency: "USD" });
    const impOut = payload(await call("import_transactions", {
      account: "Cash Stash",
      transactions: [{ date: "2026-07-10", amount: -500, currency: "EUR", merchant: "Exchange Kantor", external_id: "mrg-out-1" }],
    }));
    const impIn = payload(await call("import_transactions", {
      account: "USD Wallet",
      transactions: [{ date: "2026-07-10", amount: 552.5, currency: "USD", merchant: "Exchange Kantor", external_id: "mrg-in-1" }],
    }));
    ok("merge fixture imported", impOut.imported === 1 && impIn.imported === 1, JSON.stringify({ impOut, impIn }));
    const legs = payload(await call("get_transactions", { merchant: "Exchange Kantor" }));
    const outLeg = legs.transactions.find((t: any) => t.type === "expense");
    const inLeg = legs.transactions.find((t: any) => t.type === "income");
    const mrgBoth = await call("update_transaction", { id: outLeg.id, counter_transaction_id: inLeg.id, counter_account: "Cash Stash" });
    ok("merge rejects counter_account combo", isErr(mrgBoth));
    const mrgSelf = await call("update_transaction", { id: outLeg.id, counter_transaction_id: outLeg.id });
    ok("merge rejects self-merge", isErr(mrgSelf));
    // Survivor deliberately = the INCOME leg: exercises the flip to the source
    // account and the (accountId, externalId) unique-constraint ordering.
    const mrg = payload(await call("update_transaction", { id: inLeg.id, counter_transaction_id: outLeg.id }));
    ok(
      "merge glues expense+income into transfer",
      mrg.merged_transfer === true &&
        mrg.transfer === "Cash Stash -> USD Wallet" &&
        mrg.amount === 500 &&
        mrg.currency === "EUR" &&
        mrg.received.amount === 552.5 &&
        mrg.received.currency === "USD",
      JSON.stringify(mrg)
    );
    const legsAfter = payload(await call("get_transactions", { merchant: "Exchange Kantor" }));
    ok("absorbed leg gone, merchant cleared", legsAfter.count === 0, JSON.stringify(legsAfter));
    const reOut = payload(await call("import_transactions", {
      account: "Cash Stash",
      transactions: [{ date: "2026-07-10", amount: -500, currency: "EUR", merchant: "Exchange Kantor", external_id: "mrg-out-1" }],
    }));
    const reIn = payload(await call("import_transactions", {
      account: "USD Wallet",
      transactions: [{ date: "2026-07-10", amount: 552.5, currency: "USD", merchant: "Exchange Kantor", external_id: "mrg-in-1" }],
    }));
    ok(
      "merged legs survive re-import",
      reOut.imported === 0 && reOut.skipped?.[0]?.reason === "external_id_exists" &&
        reIn.imported === 0 && reIn.skipped?.[0]?.reason === "merged_transfer_leg",
      JSON.stringify({ reOut, reIn })
    );

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
    // The test user's connection only: this is the production database, and
    // backdating real users' connections made prod re-pull their banks.
    await adb.bankConnection.updateMany({
      where: { userId: testUser.id, provider: "enablebanking" },
      data: { lastSyncAt: new Date(Date.now() - 30 * 3600 * 1000) },
    });
    const { runAutoSync } = await import("../src/autosync");
    const auto = await runAutoSync(testUser.id);
    ok("auto-sync syncs the stale connection", auto.due === 1 && auto.synced === 1 && auto.failed === 0, JSON.stringify(auto));
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
    // 12r. Whole-repo review fixes (2026-10-01): each check pins a bug the
    // review reproduced (finding ids of that review).
    type Rec = { id: string; amount: number; name: string; account: string; budget: string };
    // TR-7: an impossible date is refused, not rolled into the next month
    ok("impossible date refused", isErr(await call("log_expense", { amount: 1, category: "other", date: "2026-09-31" })));
    // TR-5: a currency no FX source covers never reaches an account
    ok("unpriceable account currency refused", isErr(await call("create_account", { name: "Xyz Card", type: "card", currency: "XYZ" })));

    await call("create_account", { name: "Fix Card", type: "card", currency: "EUR" });
    await call("create_account", { name: "Fix UAH", type: "card", currency: "UAH" });
    await call("log_balance", { account: "Fix Card", amount: 1000, date: "2026-07-01" });
    // TW-3: a refund never absorbs the purchase it refunds; TW-5: an explicit
    // type keeps the statement's sign (positive expense = refund)
    await call("log_expense", { amount: 50, currency: "EUR", category: "clothing", merchant: "Mango", date: "2026-07-20" });
    const zara = payload(await call("import_transactions", {
      account: "Fix Card",
      transactions: [
        { date: "2026-07-22", amount: 50, currency: "EUR", type: "expense", merchant: "MANGO refund" },
        { date: "2026-07-20", amount: -50, currency: "EUR", merchant: "MANGO" },
      ],
    }));
    const zRows = payload(await call("get_transactions", { merchant: "mango" }));
    ok(
      "refund kept apart from its purchase",
      zara.imported === 1 && zara.manual_twins_merged === 1 && zRows.total === 2 &&
        zRows.transactions.some((t: Rec) => t.amount === -50) && zRows.transactions.some((t: Rec) => t.amount === 50),
      JSON.stringify({ zara, rows: zRows.transactions.map((t: Rec) => t.amount) })
    );
    // TW-6: a statement credit confirms a cross-currency transfer into the account
    await call("log_transfer", { amount: 100, from_account: "Fix Card", to_account: "Fix UAH", received_amount: 4500, received_currency: "UAH", date: "2026-07-21" });
    const uahImp = payload(await call("import_transactions", {
      account: "Fix UAH",
      transactions: [{ date: "2026-07-21", amount: 4500, currency: "UAH", merchant: "From EUR card" }],
    }));
    ok("credit confirms the transfer leg", uahImp.imported === 0 && uahImp.skipped?.[0]?.reason === "transfer_leg_matched", JSON.stringify(uahImp));
    // TW-5: a positive transfer row is money IN (own top-up), not out
    await call("import_transactions", {
      account: "Fix Card",
      transactions: [{ date: "2026-07-25", amount: 500, currency: "EUR", type: "transfer", merchant: "Top-up from Wise" }],
    });
    const fixAccs = payload(await call("get_accounts", {}));
    const fixCard = fixAccs.accounts.find((a: Rec) => a.name === "Fix Card");
    // 1000 - 50 purchase - 100 transfer + 50 refund + 500 top-up
    ok("incoming transfer and refund add to the balance", fixCard?.balance === 1400, JSON.stringify(fixCard));
    // TW-1: filler references do not swallow rows; a reused row number is a new
    // transaction once (date-scoped key), and re-importing it is idempotent
    const filler = payload(await call("import_transactions", {
      account: "Fix Card",
      transactions: [
        { date: "2026-07-26", amount: -3, currency: "EUR", merchant: "Kiosk A", external_id: "" },
        { date: "2026-07-26", amount: -4, currency: "EUR", merchant: "Kiosk B", external_id: "N/A" },
      ],
    }));
    ok("filler external_ids do not swallow rows", filler.imported === 2, JSON.stringify(filler));
    const rowSep = { date: "2026-07-02", amount: -12.5, currency: "EUR", merchant: "Shop X", external_id: "r001" };
    const rowOct = { date: "2026-08-02", amount: -30, currency: "EUR", merchant: "Shop Y", external_id: "r001" };
    const sep = payload(await call("import_transactions", { account: "Fix Card", transactions: [rowSep] }));
    const oct = payload(await call("import_transactions", { account: "Fix Card", transactions: [rowOct] }));
    const octAgain = payload(await call("import_transactions", { account: "Fix Card", transactions: [rowOct] }));
    ok(
      "reused row-number id imports the new transaction once",
      sep.imported === 1 && oct.imported === 1 && oct.external_id_conflicts === 1 && octAgain.imported === 0,
      JSON.stringify({ oct, octAgain })
    );
    // TW-4: a merged hand-logged row leaves the fuzzy pool for good
    await call("log_expense", { amount: 8, currency: "EUR", category: "transport", merchant: "Metro", date: "2026-07-27" });
    const metro1 = payload(await call("import_transactions", {
      account: "Fix Card",
      transactions: [
        { date: "2026-07-27", amount: -8, currency: "EUR", merchant: "METRO" },
        { date: "2026-07-28", amount: -8, currency: "EUR", merchant: "METRO" },
      ],
    }));
    const metro2 = payload(await call("import_transactions", {
      account: "Fix Card",
      transactions: [
        { date: "2026-07-28", amount: -8, currency: "EUR", merchant: "METRO" },
        { date: "2026-07-29", amount: -8, currency: "EUR", merchant: "METRO" },
      ],
    }));
    const metro = payload(await call("get_transactions", { merchant: "metro", limit: 2 }));
    ok(
      "merged hand-logged row is not merged again",
      metro1.manual_twins_merged === 1 && metro2.imported === 1 && metro.total === 3,
      JSON.stringify({ metro1, metro2, total: metro.total })
    );
    // TR-11: paging reports the real total and never repeats a row
    const metroP2 = payload(await call("get_transactions", { merchant: "metro", limit: 2, offset: metro.next_offset }));
    ok(
      "get_transactions pages with total/has_more",
      metro.has_more === true && metroP2.count === 1 && metroP2.has_more === false &&
        !metroP2.transactions.some((t: Rec) => metro.transactions.some((u: Rec) => u.id === t.id)),
      JSON.stringify({ next: metro.next_offset, p2: metroP2.count })
    );
    // TW-7: income converted to a transfer survives a re-import of its statement
    const fromWise = { date: "2026-07-23", amount: 1000, currency: "UAH", merchant: "Payout 777", external_id: "uah-777" };
    const w1 = payload(await call("import_transactions", { account: "Fix UAH", transactions: [fromWise] }));
    const wiseRow = payload(await call("get_transactions", { merchant: "Payout 777" })).transactions[0];
    await call("update_transaction", { id: wiseRow.id, type: "transfer", counter_account: "Fix Card" });
    const w2 = payload(await call("import_transactions", { account: "Fix UAH", transactions: [fromWise] }));
    ok(
      "converted income is found as its transfer leg",
      w1.imported === 1 && w2.imported === 0 && w2.skipped?.[0]?.reason === "merged_transfer_leg",
      JSON.stringify(w2)
    );
    // TW-15: a row moves to another account
    const kioskA = payload(await call("get_transactions", { merchant: "Kiosk A" })).transactions[0];
    await call("update_transaction", { id: kioskA.id, account: "Cash Stash" });
    const kioskAfter = payload(await call("get_transactions", { merchant: "Kiosk A" })).transactions[0];
    ok("update_transaction moves a row", kioskAfter.account === "Cash Stash", JSON.stringify(kioskAfter));
    // TW-10: a received currency without an amount is priced, never paired raw
    const tr10 = payload(await call("log_transfer", { amount: 10, from_account: "Fix Card", to_account: "Fix UAH", received_currency: "UAH", date: "2026-07-30" }));
    ok("received currency alone is priced", tr10.received?.currency === "UAH" && tr10.received.amount > 100, JSON.stringify(tr10));
    // TR-4: a snapshot logged in another currency is converted, not relabelled
    await call("create_account", { name: "Fix Wallet", type: "bank", currency: "EUR" });
    await call("log_balance", { account: "Fix Wallet", amount: 100, currency: "USD", date: "2026-07-14" });
    const wallet = payload(await call("get_accounts", {})).accounts.find((a: Rec) => a.name === "Fix Wallet");
    ok("foreign-currency snapshot converted", wallet?.currency === "EUR" && wallet.balance > 80 && wallet.balance < 95, JSON.stringify(wallet));
    // TR-9: exported cells cannot run as spreadsheet formulas
    await call("log_expense", { amount: 1, currency: "EUR", category: "other", merchant: '=HYPERLINK("https://evil.example")', date: "2026-07-31" });
    const csvInj = (await call("export_transactions", { from: "2026-07-31", to: "2026-07-31" })).json?.result?.content?.[0]?.text ?? "";
    ok("CSV export neutralises formulas", csvInj.includes(`"'=HYPERLINK(""https://evil.example"")"`), csvInj.split("\n")[1]);
    // ST-10: a budget alerts once, when an expense pushes it over the cap
    await call("set_budget", { amount: 10, category: "gifts" });
    const g1 = payload(await call("log_expense", { amount: 8, currency: "EUR", category: "gifts", merchant: "Flowers" }));
    const g2 = payload(await call("log_expense", { amount: 5, currency: "EUR", category: "gifts", merchant: "Card" }));
    const g3 = payload(await call("log_expense", { amount: 1, currency: "EUR", category: "gifts", merchant: "Ribbon" }));
    const giftAlert = (r: { budget_alerts?: Rec[] }) => (r.budget_alerts ?? []).some((b: Rec) => b.budget === "gifts");
    ok("budget alert fires once on crossing", !giftAlert(g1) && giftAlert(g2) && !giftAlert(g3), JSON.stringify({ g1: g1.budget_alerts, g2: g2.budget_alerts, g3: g3.budget_alerts }));
    const progress = payload(await call("get_budget_progress", {}));
    ok("budget progress reports days left", Number.isInteger(progress.days_left) && progress.days_left >= 0 && progress.days_left <= 30, JSON.stringify({ days_left: progress.days_left }));
    // Currencies outside ECB + NBU are priced by the fallback source (from
    // 2024-03-02); a code that is not ISO 4217 is refused
    const rub = payload(await call("log_expense", { amount: 1000, currency: "RUB", category: "other", merchant: "Fallback FX", date: "2026-09-30" }));
    ok("RUB priced by the fallback source", rub.currency === "RUB" && rub.amount_base > 5 && rub.amount_base < 20, JSON.stringify(rub));
    ok(
      "RUB before the fallback's first day refused",
      isErr(await call("log_expense", { amount: 1000, currency: "RUB", category: "other", merchant: "Fallback FX", date: "2023-05-01" }))
    );
    ok("non-ISO code refused", isErr(await call("log_expense", { amount: 1, currency: "BTC", category: "other", date: "2026-09-30" })));
    // Profile export: everything but the transactions, no secrets
    const profile = payload(await call("export_profile", {}));
    ok(
      "export_profile: settings, accounts with snapshots, budgets, rules, links",
      profile.format === "myfinance-profile/1" &&
        profile.settings?.email === EMAIL &&
        profile.accounts?.some((a: any) => Array.isArray(a.balance_snapshots) && a.balance_snapshots[0]?.length === 3) &&
        profile.budgets?.some((b: any) => b.category === "gifts") &&
        profile.merchant_rules?.length > 0 &&
        Array.isArray(profile.connections) &&
        profile.transactions?.count > 0 &&
        !/tokenEnc|session_id|e2e-eb-session/.test(JSON.stringify(profile)),
      JSON.stringify(profile).slice(0, 500)
    );
    // TR-2/TR-8: a base change is atomic and converts budget caps too
    const capOf = async () =>
      Number((await odb.budget.findFirstOrThrow({ where: { userId: testUser.id, categoryKey: "gifts" } })).amount);
    const capEur = await capOf();
    const rowsBefore = await odb.transaction.count({ where: { userId: testUser.id } });
    const synced = await odb.transaction.findFirstOrThrow({ where: { userId: testUser.id, source: "bank", currency: "EUR" } });
    const toUsd = payload(await call("update_settings", { base_currency: "USD" }));
    const capUsd = await capOf();
    const syncedUsd = await odb.transaction.findUniqueOrThrow({ where: { id: synced.id } });
    const rowsUsd = await odb.transaction.count({ where: { userId: testUser.id } });
    const toEur = payload(await call("update_settings", { base_currency: "EUR" }));
    const capBack = await capOf();
    const syncedBack = await odb.transaction.findUniqueOrThrow({ where: { id: synced.id } });
    ok(
      "base change converts budgets and round-trips",
      toUsd.base_currency === "USD" && capUsd > capEur && toEur.base_currency === "EUR" && Math.abs(capBack - capEur) <= 0.02,
      JSON.stringify({ capEur, capUsd, capBack })
    );
    ok(
      "base change reprices every row in place",
      rowsUsd === rowsBefore &&
        Number(syncedUsd.amountBase) > Number(synced.amountBase) &&
        Number(syncedUsd.fxRate) > 1 &&
        Math.abs(Number(syncedBack.amountBase) - Number(synced.amountBase)) <= 0.01 &&
        syncedBack.merchant === synced.merchant &&
        syncedBack.createdAt.getTime() === synced.createdAt.getTime(),
      JSON.stringify({ rowsBefore, rowsUsd, before: synced.amountBase, usd: syncedUsd.amountBase, back: syncedBack.amountBase })
    );
    // A switch is no user edit: syncs keep updating rows it repriced
    ok(
      "base change leaves updatedAt alone",
      syncedUsd.updatedAt.getTime() === synced.updatedAt.getTime() && syncedBack.updatedAt.getTime() === synced.updatedAt.getTime(),
      JSON.stringify({ before: synced.updatedAt, usd: syncedUsd.updatedAt, back: syncedBack.updatedAt })
    );
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

  // 13. Refresh token rotation. A refresh never widens the grant (unknown
  // scopes grant nothing). The rotated token survives a short grace window,
  // so parallel refreshes by one client all succeed.
  const refreshGrant = { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id };
  const widenRes = await tokenPost({ ...refreshGrant, scope: "admin finance:write" });
  const widened = (await widenRes.json()) as { scope?: string };
  ok(
    "refresh never widens the grant",
    widenRes.status === 200 && !String(widened.scope ?? "").includes("admin"),
    JSON.stringify({ status: widenRes.status, scope: widened.scope })
  );
  // (After the grace window a reuse revokes the whole grant: section 2b.)
  const refreshRes = await tokenPost(refreshGrant);
  const refreshed: any = await refreshRes.json();
  ok("rotated refresh token works inside the grace window", refreshRes.status === 200 && !!refreshed.access_token);
  const pingNew = await mcpCall(refreshed.access_token, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "ping", arguments: {} },
  });
  ok("new access token works", pingNew.status === 200);

  // Prod smoke signs in as a REAL account: revoke what it was issued instead
  // of leaving a live 60-day refresh token behind.
  if (externalBase) {
    await form(asMeta.revocation_endpoint, { token: refreshed.refresh_token, client_id: client.client_id });
    await form(asMeta.revocation_endpoint, { token: refreshed.access_token, client_id: client.client_id });
    const afterRevoke = await tokenPost({ grant_type: "refresh_token", refresh_token: refreshed.refresh_token, client_id: client.client_id });
    ok("prod smoke revokes its own tokens", afterRevoke.status === 400);
  }

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
    // Events have no relation to users, so nothing cascades: the wipe deletes
    // them itself, and its own tool_call is logged without the user id.
    const { db: wdb } = await import("../src/db");
    let leftover = -1;
    for (let i = 0; i < 10 && leftover !== 0; i++) {
      await Bun.sleep(100);
      leftover = await wdb.event.count({ where: { userId: testUserId } });
    }
    ok("delete_all_data leaves no events of the user", !!testUserId && leftover === 0, `found ${leftover}`);
  }

  console.log(`\ne2e PASSED: ${passed} checks green.`);
}

try {
  await main();
} finally {
  // Users created by the email sign-in checks (all @test.local).
  if (!externalBase && createdUserEmails.length) {
    try {
      const { db } = await import("../src/db");
      const users = await db.user.findMany({ where: { email: { in: createdUserEmails.filter((e) => e.endsWith("@test.local")) } } });
      const ids = users.map((u) => u.id);
      await db.oauthAccessToken.deleteMany({ where: { userId: { in: ids } } });
      await db.oauthRefreshToken.deleteMany({ where: { userId: { in: ids } } });
      await db.oauthCode.deleteMany({ where: { userId: { in: ids } } });
      await db.event.deleteMany({ where: { userId: { in: ids } } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
    } catch (e) {
      console.error("WARN: e2e user cleanup failed:", e instanceof Error ? e.message : String(e));
    }
  }
  // Spawn mode writes to the real database: never leave the run's OAuth
  // clients behind (a confidential one holds a secret that never expires),
  // whether the run passed or failed. External mode has no DB access.
  if (!externalBase && createdClients.length) {
    try {
      const { db } = await import("../src/db");
      const where = { clientId: { in: createdClients } };
      await db.oauthCode.deleteMany({ where });
      await db.oauthAccessToken.deleteMany({ where });
      await db.oauthRefreshToken.deleteMany({ where });
      await db.oauthClient.deleteMany({ where });
      await db.event.deleteMany({
        where: {
          type: { in: ["oauth_error", "oauth_refresh_replay"] },
          OR: createdClients.map((id) => ({ meta: { path: ["client_id"], equals: id } })),
        },
      });
      await db.$disconnect();
    } catch (e) {
      console.error("WARN: e2e OAuth client cleanup failed:", e instanceof Error ? e.message : String(e));
    }
  }
  (serverProc as Subprocess | null)?.kill();
  // The Zen stub's listener would otherwise keep the Bun event loop alive
  // forever after main() returns - the script must exit for the deploy gate.
  (zenStub as { stop: (closeActiveConnections?: boolean) => void } | null)?.stop(true);
  (ebStub as { stop: (closeActiveConnections?: boolean) => void } | null)?.stop(true);
  (mailStub as { stop: (closeActiveConnections?: boolean) => void } | null)?.stop(true);
}
