-- deployment-mode: rolling
-- What an agent is set up with besides its Instructions (docs/agents.md):
--
-- - tool_permissions: its Can use rules, a JSON list of
--   {connector, tool, permission}. They only make its chats stricter than the
--   connection's own choices (Ask first or Block); see tool-approvals.md.
-- - skills: the short list of Skills it relies on, by name. Display only:
--   Skills stay available to every chat.
-- - template_key: the ready-made agent it was added from, if any. Display and
--   suggested triggers only; grants nothing.
--
-- Rolling: new columns with defaults that the previous release never reads or
-- writes; its inserts get the defaults. No backfill. Shape and size are
-- validated by the API, which reports a clear error instead of a check failure.
SET LOCAL lock_timeout = '5s';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS tool_permissions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS skills jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS template_key text;
