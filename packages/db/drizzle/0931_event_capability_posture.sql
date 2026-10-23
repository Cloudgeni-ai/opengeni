-- deployment-mode: maintenance
-- maintenance-justification: The previous evaluator rejects the newly runtime-callable SECURITY DEFINER event capabilities and the non-RLS event ingress routing table's CRUD grants. Stop every old/new runtime login before this release's middle migration span, then start only the matching evaluator. No pre-0931 rollback is supported.
-- Harden 0929's inherited search paths without rewriting that published migration.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $event_capability_runtime_drain$
DECLARE
  configured_roles_text text := nullif(
    current_setting('opengeni.migration_application_roles', true), ''
  );
  configured_roles jsonb;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION
      '0931 event capability activation requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0931 event capability activation received a malformed application database role list'
      USING ERRCODE = '55000';
  END;
  IF jsonb_typeof(configured_roles) <> 'array'
    OR jsonb_array_length(configured_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(configured_roles) AS roles(value)
      WHERE jsonb_typeof(value) <> 'string'
        OR btrim(value #>> '{}') = ''
        OR btrim(value #>> '{}') IS DISTINCT FROM value #>> '{}'
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
      '0931 event capability activation received an invalid application database role list'
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
      '0931 event capability activation requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$event_capability_runtime_drain$;


DO $harden_event_capabilities$
DECLARE signature text; grantee_name text; target_schema text := current_schema();
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'list_due_event_trigger_tasks_v1(integer)',
    'prune_event_intake_v1(integer, integer, integer)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION opengeni_private.%s SET search_path = pg_catalog, %I, pg_temp', signature, target_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.%s FROM PUBLIC', signature);
    FOR grantee_name IN
      SELECT DISTINCT role.rolname
      FROM pg_proc routine
      CROSS JOIN LATERAL aclexplode(coalesce(routine.proacl, acldefault('f', routine.proowner))) acl
      JOIN pg_roles role ON role.oid = acl.grantee
      WHERE routine.oid = ('opengeni_private.' || signature)::regprocedure
        AND acl.grantee <> routine.proowner
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.%s FROM %I', signature, grantee_name);
    END LOOP;
  END LOOP;
END $harden_event_capabilities$;

DO $event_capability_runtime_drain_after$
DECLARE
  configured_roles_text text := nullif(
    current_setting('opengeni.migration_application_roles', true), ''
  );
  configured_roles jsonb;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION
      '0931 event capability activation requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0931 event capability activation received a malformed application database role list'
      USING ERRCODE = '55000';
  END;
  IF jsonb_typeof(configured_roles) <> 'array'
    OR jsonb_array_length(configured_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(configured_roles) AS roles(value)
      WHERE jsonb_typeof(value) <> 'string'
        OR btrim(value #>> '{}') = ''
        OR btrim(value #>> '{}') IS DISTINCT FROM value #>> '{}'
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
      '0931 event capability activation received an invalid application database role list'
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
      '0931 event capability activation requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$event_capability_runtime_drain_after$;
