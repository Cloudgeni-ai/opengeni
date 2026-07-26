-- Per-session working directory (Stage A: backend slice).
--
-- sessions.working_dir is the path/cwd BASE the session's (selfhosted) box
-- operates under — its agent exec, terminal pty, and structural file dock. The
-- value is a launch-workspace_root-relative subdir (resolved under workspace_root
-- by the agent's resolve_cwd) or an absolute machine path.
--
-- NULL (the default) ⇒ today's behavior EXACTLY: the agent substitutes its launch
-- workspace_root for an empty cwd, so an unset working_dir is a byte-identical
-- no-op (every existing + new row is NULL, no backfill). It is surfaced alongside
-- the active-sandbox pointer (readActiveSandbox) and written through the
-- epoch-fenced setActiveSandbox CAS, never the row INSERT — so it is seeded
-- create-time when a machine target is named, per-session.
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "working_dir" text;

-- Re-grant on the new column (idempotent; mirrors the boilerplate in earlier
-- migrations so a fresh opengeni_app role can read/write the added column).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
