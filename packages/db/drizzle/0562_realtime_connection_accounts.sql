-- deployment-mode: rolling
-- Capture only new voice leases. Historical accepted work must not acquire
-- personal authority from today's connections or a later session participant.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE session_realtime_modes
  ADD COLUMN personal_connection_delegations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN mcp_account_bindings jsonb;
