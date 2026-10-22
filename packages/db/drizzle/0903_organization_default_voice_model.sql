-- deployment-mode: rolling
-- The realtime voice model an organization chooses for new voice
-- conversations in workspaces without their own choice. Null keeps today's
-- automatic choice.
--
-- Adds one nullable column with no default, so no row is rewritten and an
-- older binary that never reads or writes it keeps working unchanged.
-- Ownership, grants and RLS are unchanged.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_model_defaults
  ADD COLUMN IF NOT EXISTS realtime_default_model text;
