-- Enable Row-Level Security on every table in the public schema.
--
-- Why: `prisma db push` creates new tables with RLS off, and Supabase exposes
-- the whole public schema through its Data API (PostgREST). A table without
-- RLS is readable and writable by anyone holding the project's anon key,
-- bypassing the MCP server and OAuth entirely. With RLS on and no policies
-- defined, anon/authenticated get deny-all; the app is unaffected because it
-- connects as the table owner, which bypasses RLS.
--
-- Run after every `prisma db push` that adds a table (idempotent):
--   psql "$DATABASE_URL" -f prisma/rls.sql
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
