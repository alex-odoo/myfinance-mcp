import { LOOPBACK_HOSTS as LOOPBACK } from "./httpUtil";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** A duration setting: anything but a non-negative number falls back to the default. */
function milliseconds(value: string | undefined, fallback: number): number {
  const n = value === undefined || value.trim() === "" ? fallback : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const config = {
  port: Number(process.env.PORT ?? 8788),
  baseUrl: (process.env.BASE_URL ?? "http://localhost:8788").replace(/\/$/, ""),
  // Older public origins served by this same container (existing connectors
  // still use them), comma-separated. Tokens bound to them stay valid here.
  legacyBaseUrls: (process.env.LEGACY_BASE_URLS ?? "https://finance.rteam.agency")
    .split(",")
    .map((url) => url.trim().replace(/\/$/, ""))
    .filter(Boolean),
  userEmail: (process.env.MYFINANCE_MCP_EMAIL ?? "").toLowerCase(),
  passwordHash: process.env.MYFINANCE_MCP_PASSWORD_HASH ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  // Google sign-in is optional: the button and /auth/google routes activate
  // only when both values are set.
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  // Google's token endpoint. The override lets e2e finish a Google sign-in
  // against a local stub; assertConfig refuses it anywhere else.
  googleTokenUrl: process.env.GOOGLE_TOKEN_URL || GOOGLE_TOKEN_URL,
  // Client ID Metadata Documents served over http from loopback: e2e only (a
  // local stub publishes the document). assertConfig refuses it elsewhere.
  cimdAllowLoopback: process.env.CIMD_ALLOW_LOOPBACK === "1",
  // Operator overview at /admin: Google sign-in, only these addresses
  // (comma-separated). Empty = the page does not exist.
  adminEmails: (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
  // Resend: signup notifications (off unless key + recipient are set) and
  // email sign-in codes (off unless key + sender are set).
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  notifyEmail: process.env.NOTIFY_EMAIL ?? "",
  fromEmail: process.env.FROM_EMAIL ?? "",
  // Also sends the sign-in codes; the base override lets e2e capture them.
  resendApiBase: (process.env.RESEND_API_BASE ?? "https://api.resend.com").replace(/\/$/, ""),
  // Signup notifications via Telegram (off unless token + chat are set).
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",
  // ZenMoney connector. Base override lets e2e point at a local stub.
  zenmoneyApiBase: (process.env.ZENMONEY_API_BASE ?? "https://api.zenmoney.ru").replace(/\/$/, ""),
  // 64 hex chars (32 bytes). Provider tokens are useless in a DB dump without it.
  // Generate: openssl rand -hex 32. Connector tools refuse to store tokens when unset.
  tokenEncKey: process.env.TOKEN_ENC_KEY ?? "",
  // Enable Banking (EU/UK open banking). App id = JWT kid; private key is the
  // base64 of the PEM (single line survives docker env-file parsing). Bank
  // connection tools stay disabled until both are set.
  ebAppId: process.env.EB_APP_ID ?? "",
  ebPrivateKeyB64: process.env.EB_PRIVATE_KEY_B64 ?? "",
  ebApiOrigin: (process.env.EB_API_ORIGIN ?? "https://api.enablebanking.com").replace(/\/$/, ""),
  // Direct bank sync (Enable Banking) is offered only to these addresses
  // (comma-separated) and to accounts that already hold a bank connection:
  // the provider app is in a restricted tier, and new users who started there
  // met a dead end. ZenMoney and statement import stay open to everyone.
  bankSyncEmails: (process.env.BANK_SYNC_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
  // Email summaries: how often the scheduler looks for due ones. 0 = off.
  digestIntervalMs: milliseconds(process.env.DIGEST_INTERVAL_MS, 60 * 60 * 1000),
  // Bank connections are auto-synced roughly daily; each tick syncs whatever
  // is >20h stale. 0 disables the scheduler (manual sync_bank still works).
  autoSyncIntervalMs: Number(process.env.AUTO_SYNC_INTERVAL_MS ?? 60 * 60 * 1000),
  // A rotated refresh token keeps working this long: a client that refreshes
  // in parallel must not lose its connector to the request that came second.
  refreshReuseGraceMs: Number(process.env.REFRESH_REUSE_GRACE_MS ?? 30_000),
  // A repeated sign-in form waits this long after the code was issued for the
  // client to redeem it, so a double click can be answered "Connected".
  signInRepeatWaitMs: milliseconds(process.env.SIGN_IN_REPEAT_WAIT_MS, 4000),
  // Commit baked into the image by deploy.sh (Docker build arg). /health
  // reports it so a deploy can prove the new container is the one serving.
  gitSha: process.env.GIT_SHA ?? "dev",
};

export function assertConfig(): void {
  if (!config.userEmail || !config.passwordHash) {
    throw new Error(
      "MYFINANCE_MCP_EMAIL and MYFINANCE_MCP_PASSWORD_HASH are required. " +
        "Generate the hash with: bun -e \"console.log(await Bun.password.hash(process.argv[1]))\" 'your-password'"
    );
  }
  // The id_token is trusted for arriving from this URL (its signature is not
  // checked), so whoever answers here decides who signs in, admin included.
  // Only a local test setup, both ends on loopback, may point it elsewhere.
  if (config.googleTokenUrl !== GOOGLE_TOKEN_URL) {
    const host = (url: string) => {
      try {
        return new URL(url).hostname;
      } catch {
        return "";
      }
    };
    if (!LOOPBACK.has(host(config.googleTokenUrl)) || !LOOPBACK.has(host(config.baseUrl))) {
      throw new Error("GOOGLE_TOKEN_URL may differ from Google's only in a local test setup (it and BASE_URL on loopback).");
    }
  }
  // A client_id on http://127.0.0.1 is any local process: only a local test
  // setup may accept one.
  if (config.cimdAllowLoopback) {
    let baseHost = "";
    try {
      baseHost = new URL(config.baseUrl).hostname;
    } catch {
      /* refused below */
    }
    if (!LOOPBACK.has(baseHost)) throw new Error("CIMD_ALLOW_LOOPBACK is for a local test setup only (BASE_URL on loopback).");
  }
  if (config.adminEmails.length && !(config.googleClientId && config.googleClientSecret)) {
    console.warn("[admin] ADMIN_EMAILS is set, but Google sign-in is not configured: /admin stays off.");
  }
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required (Supabase Postgres, session pooler URL).");
  }
}
