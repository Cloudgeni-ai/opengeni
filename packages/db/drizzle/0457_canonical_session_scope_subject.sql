-- deployment-mode: maintenance
-- Deploy with the embedding maintenance cutover: stop old API/worker writers
-- before activation and never restart a label-authority binary afterward.
-- New sessions bind agent scope to canonical authenticated user authority.
-- Do not infer a user from historical end_user labels or promote old private
-- memory rows. Old sessions remain readable under their existing visibility;
-- a null scope cannot grant cross-tree user access. Their old labels and
-- session-scoped memory records are retained as historical data only.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $drain$
DECLARE
  roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0457 requires an explicit application database role list' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item
    WHERE jsonb_typeof(item) <> 'string' OR btrim(item #>> '{}') = ''
      OR item #>> '{}' <> btrim(item #>> '{}') OR octet_length(item #>> '{}') > 63
  ) THEN
    RAISE EXCEPTION '0457 received invalid application database roles' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(roles) role_name ON role_name = activity.usename
    WHERE activity.datname = current_database() AND activity.pid <> pg_backend_pid()
  ) THEN
    RAISE EXCEPTION '0457 requires all application database sessions stopped' USING ERRCODE = '55000';
  END IF;
END
$drain$;

ALTER TABLE sessions ADD COLUMN scope_subject_id text,
  ADD CONSTRAINT sessions_scope_subject_id_check CHECK (
    scope_subject_id IS NULL OR (
      octet_length(scope_subject_id) BETWEEN 1 AND 1024
      AND scope_subject_id ~ '^(user:|external_user:).+'
    )
  );

CREATE INDEX sessions_workspace_scope_subject_idx
  ON sessions (workspace_id, scope_subject_id)
  WHERE scope_subject_id IS NOT NULL;