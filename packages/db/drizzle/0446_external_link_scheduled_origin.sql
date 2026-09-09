-- deployment-mode: maintenance
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $migration$
DECLARE
  roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
  definition text := pg_get_functiondef('opengeni_private.guard_external_link_work_snapshot()'::regprocedure);
  prior text := 'AND r.accepted_execution #>> ''{causalHuman,subjectId}'' = l.native_subject_id';
  replacement text := $clause$AND r.status = 'dispatched'
      AND r.accepted_execution_snapshot ->> 'causalHumanSubjectId' = l.native_subject_id
      AND validate_scheduled_agent_run_live_authority(NEW.account_id, NEW.workspace_id, r.id) IS NULL$clause$;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0446 requires application database roles' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}')
      OR octet_length(item #>> '{}') > 63
  ) THEN RAISE EXCEPTION '0446 invalid application roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0446 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
  IF length(definition) - length(replace(definition, prior, '')) <> length(prior) THEN
    RAISE EXCEPTION '0446 expected exactly one scheduled origin clause' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, prior, replacement);
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0446 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$migration$;