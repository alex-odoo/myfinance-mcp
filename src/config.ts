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
  // Signup notifications via Resend (off unless the key is set).
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  notifyEmail: process.env.NOTIFY_EMAIL ?? "alex@rteam.top",
  fromEmail: process.env.FROM_EMAIL ?? "notifications@rteam.agency",
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
