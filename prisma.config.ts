import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    // CLI commands (db push, studio): export DATABASE_URL or rely on Bun .env autoload
    url: process.env.DATABASE_URL ?? "",
  },
});
