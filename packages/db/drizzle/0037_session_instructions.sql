-- Per-session agent persona/system instructions.
--
-- An optional per-agent-type prompt supplied by an embedding host at session
-- creation. It rides the SAME system-level instructions channel the
-- per-workspace agent_instructions rides, composed AFTER the workspace persona
-- so it refines it for this one session — never as a user-visible timeline
-- event. NULL means the session carried none, so every existing row keeps its
-- historical, byte-identical composed instructions after this migration without
-- a backfill. Org-visible metadata, not a secret.
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "instructions" text;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
