export const config = {
  port: Number(process.env.PORT ?? 8788),
  baseUrl: (process.env.BASE_URL ?? "http://localhost:8788").replace(/\/$/, ""),
  userEmail: (process.env.MYFINANCE_MCP_EMAIL ?? "").toLowerCase(),
  passwordHash: process.env.MYFINANCE_MCP_PASSWORD_HASH ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  // Google sign-in is optional: the button and /auth/google routes activate
  // only when both values are set.
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  // Signup notifications via Resend (off unless key + recipient are set).
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  notifyEmail: process.env.NOTIFY_EMAIL ?? "",
  fromEmail: process.env.FROM_EMAIL ?? "",
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
};

export function assertConfig(): void {
  if (!config.userEmail || !config.passwordHash) {
    throw new Error(
      "MYFINANCE_MCP_EMAIL and MYFINANCE_MCP_PASSWORD_HASH are required. " +
        "Generate the hash with: bun -e \"console.log(await Bun.password.hash(process.argv[1]))\" 'your-password'"
    );
  }
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required (Supabase Postgres, session pooler URL).");
  }
}
