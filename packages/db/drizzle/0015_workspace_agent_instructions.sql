-- Per-workspace white-label agent persona override.
--
-- NULL means "use the deployment default template"
-- (OPENGENI_AGENT_INSTRUCTIONS_TEMPLATE / DEFAULT_AGENT_INSTRUCTIONS), so every
-- existing workspace keeps the historical, byte-identical preamble after this
-- migration without a backfill. The runtime always injects the non-bypassable
-- CORE (goal-loop ownership + workspace-environment block) regardless of this
-- value, so an override can restyle the persona but never drop that contract.
ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "agent_instructions" text;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
