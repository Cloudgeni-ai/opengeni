-- deployment-mode: rolling
-- Session-local approval settings do not copy or grant capability definitions.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
ALTER TABLE sessions ADD COLUMN mcp_approval_policies jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(mcp_approval_policies) = 'object');