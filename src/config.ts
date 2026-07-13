export const config = {
  port: Number(process.env.PORT ?? 8788),
  baseUrl: (process.env.BASE_URL ?? "http://localhost:8788").replace(/\/$/, ""),
  userEmail: (process.env.FINANCE_MCP_EMAIL ?? "").toLowerCase(),
  passwordHash: process.env.FINANCE_MCP_PASSWORD_HASH ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
};

export function assertConfig(): void {
  if (!config.userEmail || !config.passwordHash) {
    throw new Error(
      "FINANCE_MCP_EMAIL and FINANCE_MCP_PASSWORD_HASH are required. " +
        "Generate the hash with: bun -e \"console.log(await Bun.password.hash(process.argv[1]))\" 'your-password'"
    );
  }
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required (Supabase Postgres, session pooler URL).");
  }
}
