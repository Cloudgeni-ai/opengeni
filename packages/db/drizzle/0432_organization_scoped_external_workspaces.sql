-- deployment-mode: maintenance
-- Stop every old API and worker before activation. Old binaries use a global
-- conflict target and must not restart after this organization-scoped cutover.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $drain$
DECLARE
  roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0432 requires an explicit application database role list' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item
    WHERE jsonb_typeof(item) <> 'string' OR btrim(item #>> '{}') = ''
      OR item #>> '{}' <> btrim(item #>> '{}') OR octet_length(item #>> '{}') > 63
  ) THEN
    RAISE EXCEPTION '0432 received invalid application database roles' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(roles) role_name ON role_name = activity.usename
    WHERE activity.datname = current_database() AND activity.pid <> pg_backend_pid()
  ) THEN
    RAISE EXCEPTION '0432 requires all application database sessions stopped' USING ERRCODE = '55000';
  END IF;
END
$drain$;

LOCK TABLE workspaces IN ACCESS EXCLUSIVE MODE;

DO $cutover$
DECLARE
  definition text;
  old_target constant text := 'ON CONFLICT (external_source, external_id) DO UPDATE';
  new_target constant text := 'ON CONFLICT (account_id, external_source, external_id) DO UPDATE';
  old_personal_guard constant text := 'WHERE conflicting_workspace.external_source = ''opengeni:organization-membership''';
  new_personal_guard constant text := 'WHERE conflicting_workspace.account_id = p_account_id AND conflicting_workspace.external_source = ''opengeni:organization-membership''';
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) role_name
      ON role_name = activity.usename
    WHERE activity.datname = current_database() AND activity.pid <> pg_backend_pid()
  ) THEN
    RAISE EXCEPTION '0432 requires all application database sessions stopped' USING ERRCODE = '55000';
  END IF;
  -- Preserve the deployed lifecycle function, including its security attributes
  -- and all intervening fixes. Fail closed if its one reviewed target drifted.
  SELECT pg_get_functiondef('organization_membership_command(jsonb)'::regprocedure) INTO definition;
  IF strpos(definition, 'RETURN organization_membership_command_0263(p_command);') = 0 THEN
    RAISE EXCEPTION '0432 organization membership wrapper drifted' USING ERRCODE = '55000';
  END IF;
  -- The live wrapper retains the newer offboarding/session-tenancy fences;
  -- invitation acceptance delegates to this separately named implementation.
  SELECT pg_get_functiondef('organization_membership_command_0263(jsonb)'::regprocedure) INTO definition;
  IF (length(definition) - length(replace(definition, old_target, ''))) / length(old_target) <> 1 THEN
    RAISE EXCEPTION '0432 organization membership conflict target drifted' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, old_target, new_target);
  SELECT pg_get_functiondef('ensure_managed_human_personal_workspace(uuid,text,uuid)'::regprocedure) INTO definition;
  IF (length(definition) - length(replace(definition, old_personal_guard, ''))) / length(old_personal_guard) <> 1 THEN
    RAISE EXCEPTION '0432 personal workspace conflict guard drifted' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, old_personal_guard, new_personal_guard);
END
$cutover$;

DROP INDEX workspaces_external_idx;
CREATE UNIQUE INDEX workspaces_external_idx ON workspaces (account_id, external_source, external_id);