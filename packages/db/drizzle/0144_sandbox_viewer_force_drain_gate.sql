-- deployment-mode: maintenance
-- A workspace that has exhausted its managed-credit balance or monthly warm
-- allowance must not let an open dashboard immediately re-arm a viewer-only
-- sandbox during the drain grace. Persist that admission intent independently
-- of any one lease so it survives provider teardown and a cold successor row.

SET LOCAL lock_timeout = '5s';
-- Old application processes do not honor this new workspace gate. Activate it
-- only while the maintenance operator has stopped every opengeni_app session.
SET LOCAL statement_timeout = '30min';

DO $maintenance_preflight_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'sandbox viewer force-drain gate activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$maintenance_preflight_guard$;

LOCK TABLE workspaces IN ACCESS EXCLUSIVE MODE;

DO $maintenance_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'sandbox viewer force-drain gate activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$maintenance_guard$;

ALTER TABLE workspaces
  ADD COLUMN sandbox_viewer_force_drain_reason text,
  ADD COLUMN sandbox_viewer_force_drain_requested_at timestamptz;

ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_sandbox_viewer_force_drain_check
  CHECK (
    (
      sandbox_viewer_force_drain_reason IS NULL
      AND sandbox_viewer_force_drain_requested_at IS NULL
    )
    OR
    (
      sandbox_viewer_force_drain_reason IN ('balance', 'warm_cap')
      AND sandbox_viewer_force_drain_requested_at IS NOT NULL
    )
  );

CREATE INDEX workspaces_sandbox_viewer_force_drain_idx
  ON workspaces (id)
  WHERE sandbox_viewer_force_drain_reason IS NOT NULL;

-- The global sandbox reaper must keep reevaluating a persisted admission gate
-- after every affected lease becomes cold. Returning workspace identity only
-- keeps billing values and tenant data behind their existing scoped reads.
CREATE OR REPLACE FUNCTION opengeni_private.list_sandbox_viewer_force_drain_workspaces()
RETURNS TABLE (workspace_id uuid)
LANGUAGE sql
SECURITY DEFINER
-- EMBED-SAFE: inherit the caller's target-schema search_path, matching the
-- existing cross-workspace sandbox inventory functions.
AS $$
  SELECT W.id
  FROM workspaces W
  WHERE W.sandbox_viewer_force_drain_reason IS NOT NULL
  ORDER BY W.id;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE
      ON FUNCTION opengeni_private.list_sandbox_viewer_force_drain_workspaces()
      TO opengeni_app;
  END IF;
END $$;
