-- deployment-mode: rolling
-- App server code (docs/app-server-code.md).
--
-- * workspace_artifact_versions.server_manifest: the server code an app
--   version carries beside its HTML ({main, files: [{path, sha256,
--   sizeBytes}], egress, secrets, digest}); the files live in object storage,
--   content-addressed per workspace. NULL is an app without server code, so
--   adding the column rewrites no rows, and the previous release, which
--   never reads or writes it, keeps working (it serves such a version
--   without its server code). The immutability trigger is a row trigger and
--   does not fire for ADD COLUMN.
-- * app_server_runs: one row per run of an app's server code (trigger,
--   status, duration, error and bounded console output) for the app's
--   managers. The API prunes rows older than 14 days per app.
--
-- Rolling: a nullable column and a new table the previous release never
-- reads or writes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE workspace_artifact_versions ADD COLUMN IF NOT EXISTS server_manifest jsonb;
COMMENT ON COLUMN workspace_artifact_versions.server_manifest IS 'App server code of this version: {main, files: [{path, sha256, sizeBytes}], egress, secrets, digest}; null without server code.';

CREATE TABLE app_server_runs (
  id uuid NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  site_id uuid NOT NULL,
  version_id uuid NOT NULL,
  trigger text NOT NULL,
  target text NOT NULL,
  status text NOT NULL,
  http_status integer,
  duration_ms integer NOT NULL,
  error text,
  logs text NOT NULL DEFAULT '',
  viewer_subject_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_server_runs_pkey PRIMARY KEY (id),
  CONSTRAINT app_server_runs_trigger_check CHECK (trigger IN ('request', 'manual')),
  CONSTRAINT app_server_runs_target_check CHECK (char_length(target) BETWEEN 1 AND 600),
  CONSTRAINT app_server_runs_status_check CHECK (status IN ('ok', 'error')),
  CONSTRAINT app_server_runs_http_status_check
    CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  CONSTRAINT app_server_runs_duration_check CHECK (duration_ms >= 0),
  CONSTRAINT app_server_runs_error_check CHECK (error IS NULL OR char_length(error) <= 2000),
  CONSTRAINT app_server_runs_logs_check CHECK (char_length(logs) <= 8000),
  CONSTRAINT app_server_runs_viewer_check
    CHECK (viewer_subject_id IS NULL OR char_length(viewer_subject_id) BETWEEN 1 AND 1024),
  CONSTRAINT app_server_runs_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT app_server_runs_site_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX app_server_runs_site_created_idx
  ON app_server_runs (workspace_id, site_id, created_at DESC);
COMMENT ON TABLE app_server_runs IS 'Runs of an app''s server code: trigger, status, duration, error and bounded console output.';

ALTER TABLE app_server_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_server_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON app_server_runs
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

REVOKE ALL ON TABLE app_server_runs FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    -- Default privileges may already have granted more; start from none.
    EXECUTE 'REVOKE ALL ON TABLE app_server_runs FROM opengeni_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app_server_runs TO opengeni_app';
  END IF;
END
$$;
