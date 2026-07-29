-- deployment-mode: maintenance
-- Make personal integration credentials subject-owned at the database boundary.
-- Every old API/control/turn writer MUST be stopped before activation: old writers
-- do not establish opengeni.subject_id and can persist workspace-visible OAuth refs.

SET LOCAL lock_timeout = '5s';
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
      'connection subject-isolation activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$maintenance_preflight_guard$;

LOCK TABLE connections IN ACCESS EXCLUSIVE MODE;
LOCK TABLE capability_installations IN ACCESS EXCLUSIVE MODE;

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
      'connection subject-isolation activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$maintenance_guard$;

-- Migration 0039 initially stored generic MCP OAuth rows as workspace-shared.
-- Backfill only Slack's exact official hosted MCP endpoint, and only where the
-- OAuth callback recorded the authenticating subject. Workspace app installs,
-- manual Slack credentials, and ambiguous legacy rows are deliberately untouched.
UPDATE connections
SET subject_id = created_by_subject_id,
    updated_at = now()
WHERE subject_id IS NULL
  AND kind = 'oauth2'
  AND provider_domain = 'slack.com'
  AND metadata ->> 'mcpUrl' = 'https://mcp.slack.com/mcp'
  AND created_by_subject_id IS NOT NULL
  AND btrim(created_by_subject_id) <> '';

-- Capability installation metadata is workspace-visible. Preserve only a
-- generic subject selector; the concrete personal connection UUID remains in
-- the subject-protected connection row and is selected at turn execution.
UPDATE capability_installations AS installation
SET config = jsonb_set(
  installation.config #- '{connectionRef,connectionId}',
  '{connectionRef,subjectScope}',
  '"subject"'::jsonb,
  true
)
WHERE jsonb_typeof(installation.config -> 'connectionRef') = 'object'
  AND EXISTS (
    SELECT 1
    FROM connections AS connection
    WHERE connection.id::text = installation.config #>> '{connectionRef,connectionId}'
      AND connection.account_id = installation.account_id
      AND connection.workspace_id = installation.workspace_id
      AND connection.subject_id IS NOT NULL
      AND connection.kind = 'oauth2'
      AND connection.provider_domain = 'slack.com'
      AND connection.metadata ->> 'mcpUrl' = 'https://mcp.slack.com/mcp'
  );

DROP POLICY IF EXISTS workspace_isolation ON connections;
CREATE POLICY workspace_isolation ON connections
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND (
      subject_id IS NULL
      OR subject_id = nullif(current_setting('opengeni.subject_id', true), '')
    )
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND (
      subject_id IS NULL
      OR subject_id = nullif(current_setting('opengeni.subject_id', true), '')
    )
  );
