-- deployment-mode: maintenance
-- Stop old API/control/turn workers before applying. Channel foreign-key
-- detachment must participate in the existing activity gate; old delete callers
-- do not open that gate. Start only the activity-aware deleteChannel binary.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $session_filter_activity_runtime_drain_before_lock$
DECLARE
  configured_roles_text text := nullif(
    current_setting('opengeni.migration_application_roles', true), ''
  );
  configured_roles jsonb;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION
      '0413 session filter activity requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0413 session filter activity received a malformed application database role list'
      USING ERRCODE = '55000';
  END;
  IF jsonb_typeof(configured_roles) <> 'array'
    OR jsonb_array_length(configured_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(configured_roles) AS roles(value)
      WHERE jsonb_typeof(value) <> 'string'
        OR btrim(value #>> '{}') = ''
        OR value #>> '{}' <> btrim(value #>> '{}')
        OR octet_length(value #>> '{}') > 63
    )
    OR (
      SELECT count(*) FROM jsonb_array_elements_text(configured_roles)
    ) <> (
      SELECT count(DISTINCT value)
      FROM jsonb_array_elements_text(configured_roles) AS roles(value)
    )
  THEN
    RAISE EXCEPTION
      '0413 session filter activity received an invalid application database role list'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0413 session filter activity requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$session_filter_activity_runtime_drain_before_lock$;

LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE;

DO $session_filter_activity_runtime_drain_after_lock$
DECLARE
  configured_roles jsonb := current_setting(
    'opengeni.migration_application_roles', false
  )::jsonb;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0413 session filter activity requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$session_filter_activity_runtime_drain_after_lock$;


DROP TRIGGER sessions_mark_activity_pending ON sessions;
CREATE TRIGGER sessions_mark_activity_pending
BEFORE INSERT OR UPDATE OF updated_at, channel_id, activity_revision, activity_revision_pending_xid
ON sessions
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.mark_session_activity_pending();

-- Equality-prefix lookup keeps a sparse creator filter from walking all newer
-- workspace rows before finding its bounded updated_at/id page.
CREATE INDEX sessions_workspace_creator_updated_id_idx
ON sessions (workspace_id, created_by_kind, created_by_subject_id, updated_at DESC, id DESC);
