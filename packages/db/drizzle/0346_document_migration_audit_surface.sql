-- deployment-mode: rolling
-- Organization-admin read surfaces for the immutable Document authority and
-- Default-collection migration evidence introduced by 0339. Audit reads use a
-- target-schema-local, exact-token capability that cannot grant write access or
-- collide with a second OpenGeni schema in the same database.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE document_migration_audit_capabilities (
  capability_id uuid PRIMARY KEY,
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  capability_kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT document_migration_audit_capabilities_kind_chk CHECK (
    capability_kind IN ('default_backfill_audit', 'reclassification_audit')
  )
);
REVOKE ALL ON TABLE document_migration_audit_capabilities FROM PUBLIC;

CREATE FUNCTION document_migration_audit_capability_active(p_capability_kind text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
  SELECT EXISTS (
    SELECT 1
    FROM document_migration_audit_capabilities capability
    WHERE capability.capability_id::text =
        nullif(current_setting('opengeni.document_migration_audit_token', true), '')
      AND capability.backend_pid = pg_backend_pid()
      AND capability.transaction_id = pg_current_xact_id_if_assigned()
      AND capability.capability_kind = p_capability_kind
  )
$body$;
REVOKE ALL ON FUNCTION document_migration_audit_capability_active(text) FROM PUBLIC;

CREATE FUNCTION assert_document_migration_audit_authority(p_command jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  account_id_value uuid := nullif(p_command ->> 'accountId', '')::uuid;
  workspace_id_value uuid := nullif(p_command ->> 'workspaceId', '')::uuid;
  actor_subject text := nullif(p_command ->> 'actorSubjectId', '');
  authorization_value jsonb := p_command -> 'accountAdminAuthorization';
BEGIN
  IF p_command IS NULL OR account_id_value IS NULL OR workspace_id_value IS NULL
    OR actor_subject IS NULL
  THEN
    RAISE EXCEPTION 'document migration audit authority is incomplete'
      USING ERRCODE = '22023';
  END IF;
  IF account_id_value IS DISTINCT FROM nullif(
      current_setting('opengeni.account_id', true), ''
    )::uuid
    OR workspace_id_value IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
    OR actor_subject IS DISTINCT FROM nullif(
      current_setting('opengeni.subject_id', true), ''
    )
  THEN
    RAISE EXCEPTION 'document migration audit scope is invalid'
      USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(authorization_value) IS DISTINCT FROM 'object'
    OR authorization_value ->> 'permission' IS DISTINCT FROM 'account:admin'
    OR coalesce(authorization_value ->> 'accountId', '')
      !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR (authorization_value ->> 'accountId')::uuid IS DISTINCT FROM account_id_value
    OR nullif(authorization_value ->> 'actorSubjectId', '') IS DISTINCT FROM actor_subject
    OR coalesce(authorization_value ->> 'authorizationId', '')
      !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION 'document migration audit requires organization administration'
      USING ERRCODE = '42501';
  END IF;
END;
$body$;
REVOKE ALL ON FUNCTION assert_document_migration_audit_authority(jsonb) FROM PUBLIC;

DO $document_migration_audit_policies$
DECLARE
  data_schema text := current_schema();
  migration_owner text := current_user;
  table_name text;
  capability_kind text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'document_default_collection_backfill_runs',
    'document_default_collection_backfill_operations',
    'document_default_collection_backfill_receipts',
    'document_authority_reclassifications'
  ] LOOP
    capability_kind := CASE
      WHEN table_name = 'document_authority_reclassifications'
        THEN 'reclassification_audit'
      ELSE 'default_backfill_audit'
    END;
    EXECUTE format(
      'CREATE POLICY document_migration_audit_read ON %I.%I '
        || 'FOR SELECT USING (current_user = %L AND '
        || '%I.document_migration_audit_capability_active(%L))',
      data_schema, table_name, migration_owner, data_schema, capability_kind
    );
  END LOOP;
END;
$document_migration_audit_policies$;

CREATE FUNCTION list_document_default_collection_backfill_runs(p_command jsonb)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  account_id_value uuid := nullif(p_command ->> 'accountId', '')::uuid;
  limit_value integer := coalesce((p_command ->> 'limit')::integer, 50);
  before_started_at timestamptz := nullif(p_command ->> 'beforeStartedAt', '')::timestamptz;
  before_run_id uuid := nullif(p_command ->> 'beforeRunId', '')::uuid;
  audit_capability_id uuid := gen_random_uuid();
  previous_audit_token text := current_setting(
    'opengeni.document_migration_audit_token', true
  );
  row_value jsonb;
BEGIN
  PERFORM assert_document_migration_audit_authority(p_command);
  IF limit_value NOT BETWEEN 1 AND 101 THEN
    RAISE EXCEPTION 'document migration audit limit is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF (before_started_at IS NULL) IS DISTINCT FROM (before_run_id IS NULL) THEN
    RAISE EXCEPTION 'document migration audit cursor is invalid'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO document_migration_audit_capabilities (
    capability_id, backend_pid, transaction_id, capability_kind
  ) VALUES (
    audit_capability_id, pg_backend_pid(), pg_current_xact_id(),
    'default_backfill_audit'
  );
  PERFORM set_config(
    'opengeni.document_migration_audit_token', audit_capability_id::text, true
  );

  FOR row_value IN
    SELECT jsonb_build_object(
      'runId', run.run_id,
      'actorSubjectId', run.actor_subject_id,
      'status', run.status,
      'lastWorkspaceId', run.last_workspace_id,
      'processedCount', run.processed_count,
      'createdCount', run.created_count,
      'adoptedCount', run.adopted_count,
      'startedAt', run.started_at,
      'updatedAt', run.updated_at,
      'completedAt', run.completed_at
    )
    FROM document_default_collection_backfill_runs run
    WHERE run.account_id = account_id_value
      AND (
        before_started_at IS NULL
        OR (run.started_at, run.run_id) < (before_started_at, before_run_id)
      )
    ORDER BY run.started_at DESC, run.run_id DESC
    LIMIT limit_value
  LOOP
    RETURN NEXT row_value;
  END LOOP;

  DELETE FROM document_migration_audit_capabilities
  WHERE capability_id = audit_capability_id;
  PERFORM set_config(
    'opengeni.document_migration_audit_token', coalesce(previous_audit_token, ''), true
  );
  RETURN;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM document_migration_audit_capabilities
  WHERE capability_id = audit_capability_id;
  PERFORM set_config(
    'opengeni.document_migration_audit_token', coalesce(previous_audit_token, ''), true
  );
  RAISE;
END;
$body$;
REVOKE ALL ON FUNCTION list_document_default_collection_backfill_runs(jsonb) FROM PUBLIC;

CREATE FUNCTION get_document_default_collection_backfill_audit(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  account_id_value uuid := nullif(p_command ->> 'accountId', '')::uuid;
  run_id_value uuid := nullif(p_command ->> 'runId', '')::uuid;
  requested_limit integer := coalesce((p_command ->> 'limit')::integer, 50);
  page_limit integer;
  operation_before_created_at timestamptz := nullif(
    p_command ->> 'operationBeforeCreatedAt', ''
  )::timestamptz;
  operation_before_id uuid := nullif(p_command ->> 'operationBeforeId', '')::uuid;
  receipt_after_workspace_id uuid := nullif(
    p_command ->> 'receiptAfterWorkspaceId', ''
  )::uuid;
  audit_capability_id uuid := gen_random_uuid();
  previous_audit_token text := current_setting(
    'opengeni.document_migration_audit_token', true
  );
  result_value jsonb;
BEGIN
  PERFORM assert_document_migration_audit_authority(p_command);
  IF run_id_value IS NULL THEN
    RAISE EXCEPTION 'document Default collection backfill audit run id is required'
      USING ERRCODE = '22023';
  END IF;
  IF requested_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'document migration audit limit is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF (operation_before_created_at IS NULL)
    IS DISTINCT FROM (operation_before_id IS NULL)
  THEN
    RAISE EXCEPTION 'document migration audit cursor is invalid'
      USING ERRCODE = '22023';
  END IF;
  page_limit := requested_limit + 1;

  INSERT INTO document_migration_audit_capabilities (
    capability_id, backend_pid, transaction_id, capability_kind
  ) VALUES (
    audit_capability_id, pg_backend_pid(), pg_current_xact_id(),
    'default_backfill_audit'
  );
  PERFORM set_config(
    'opengeni.document_migration_audit_token', audit_capability_id::text, true
  );

  SELECT jsonb_build_object(
    'run', jsonb_build_object(
      'runId', run.run_id,
      'actorSubjectId', run.actor_subject_id,
      'status', run.status,
      'lastWorkspaceId', run.last_workspace_id,
      'processedCount', run.processed_count,
      'createdCount', run.created_count,
      'adoptedCount', run.adopted_count,
      'startedAt', run.started_at,
      'updatedAt', run.updated_at,
      'completedAt', run.completed_at
    ),
    'operations', coalesce((
      SELECT jsonb_agg(item.value ORDER BY item.created_at DESC, item.operation_id DESC)
      FROM (
        SELECT
          operation.created_at,
          operation.operation_id,
          jsonb_build_object(
            'operationId', operation.operation_id,
            'result', operation.result,
            'createdAt', operation.created_at
          ) AS value
        FROM document_default_collection_backfill_operations operation
        WHERE operation.account_id = account_id_value
          AND operation.run_id = run_id_value
          AND (
            operation_before_created_at IS NULL
            OR (operation.created_at, operation.operation_id)
              < (operation_before_created_at, operation_before_id)
          )
        ORDER BY operation.created_at DESC, operation.operation_id DESC
        LIMIT page_limit
      ) item
    ), '[]'::jsonb),
    'receipts', coalesce((
      SELECT jsonb_agg(item.value ORDER BY item.workspace_id)
      FROM (
        SELECT
          receipt.workspace_id,
          jsonb_build_object(
            'workspaceId', receipt.workspace_id,
            'baseId', receipt.base_id,
            'outcome', receipt.outcome,
            'createdAt', receipt.created_at
          ) AS value
        FROM document_default_collection_backfill_receipts receipt
        WHERE receipt.account_id = account_id_value
          AND receipt.run_id = run_id_value
          AND (
            receipt_after_workspace_id IS NULL
            OR receipt.workspace_id > receipt_after_workspace_id
          )
        ORDER BY receipt.workspace_id
        LIMIT page_limit
      ) item
    ), '[]'::jsonb)
  ) INTO result_value
  FROM document_default_collection_backfill_runs run
  WHERE run.account_id = account_id_value
    AND run.run_id = run_id_value;

  DELETE FROM document_migration_audit_capabilities
  WHERE capability_id = audit_capability_id;
  PERFORM set_config(
    'opengeni.document_migration_audit_token', coalesce(previous_audit_token, ''), true
  );
  IF result_value IS NULL THEN
    RAISE EXCEPTION 'document Default collection backfill audit run is unavailable'
      USING ERRCODE = 'P0002';
  END IF;
  RETURN result_value;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM document_migration_audit_capabilities
  WHERE capability_id = audit_capability_id;
  PERFORM set_config(
    'opengeni.document_migration_audit_token', coalesce(previous_audit_token, ''), true
  );
  RAISE;
END;
$body$;
REVOKE ALL ON FUNCTION get_document_default_collection_backfill_audit(jsonb) FROM PUBLIC;

CREATE FUNCTION list_organization_document_authority_reclassifications(p_command jsonb)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  account_id_value uuid := nullif(p_command ->> 'accountId', '')::uuid;
  limit_value integer := coalesce((p_command ->> 'limit')::integer, 50);
  before_created_at timestamptz := nullif(p_command ->> 'beforeCreatedAt', '')::timestamptz;
  before_operation_id uuid := nullif(p_command ->> 'beforeOperationId', '')::uuid;
  audit_capability_id uuid := gen_random_uuid();
  previous_audit_token text := current_setting(
    'opengeni.document_migration_audit_token', true
  );
  row_value jsonb;
BEGIN
  PERFORM assert_document_migration_audit_authority(p_command);
  IF limit_value NOT BETWEEN 1 AND 101 THEN
    RAISE EXCEPTION 'document migration audit limit is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF (before_created_at IS NULL) IS DISTINCT FROM (before_operation_id IS NULL) THEN
    RAISE EXCEPTION 'document migration audit cursor is invalid'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO document_migration_audit_capabilities (
    capability_id, backend_pid, transaction_id, capability_kind
  ) VALUES (
    audit_capability_id, pg_backend_pid(), pg_current_xact_id(),
    'reclassification_audit'
  );
  PERFORM set_config(
    'opengeni.document_migration_audit_token', audit_capability_id::text, true
  );

  FOR row_value IN
    SELECT receipt.result || jsonb_build_object(
      'actorSubjectId', receipt.actor_subject_id,
      'requestWorkspaceId', receipt.request_workspace_id
    )
    FROM document_authority_reclassifications receipt
    WHERE receipt.account_id = account_id_value
      AND (
        before_created_at IS NULL
        OR (receipt.created_at, receipt.operation_id)
          < (before_created_at, before_operation_id)
      )
    ORDER BY receipt.created_at DESC, receipt.operation_id DESC
    LIMIT limit_value
  LOOP
    RETURN NEXT row_value;
  END LOOP;

  DELETE FROM document_migration_audit_capabilities
  WHERE capability_id = audit_capability_id;
  PERFORM set_config(
    'opengeni.document_migration_audit_token', coalesce(previous_audit_token, ''), true
  );
  RETURN;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM document_migration_audit_capabilities
  WHERE capability_id = audit_capability_id;
  PERFORM set_config(
    'opengeni.document_migration_audit_token', coalesce(previous_audit_token, ''), true
  );
  RAISE;
END;
$body$;
REVOKE ALL ON FUNCTION
  list_organization_document_authority_reclassifications(jsonb) FROM PUBLIC;

DO $document_migration_audit_search_paths$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.document_migration_audit_capability_active(text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.assert_document_migration_audit_authority(jsonb) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.list_document_default_collection_backfill_runs(jsonb) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.get_document_default_collection_backfill_audit(jsonb) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.list_organization_document_authority_reclassifications(jsonb) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
END;
$document_migration_audit_search_paths$;

DO $document_migration_audit_runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      list_document_default_collection_backfill_runs(jsonb) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      get_document_default_collection_backfill_audit(jsonb) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      list_organization_document_authority_reclassifications(jsonb) TO opengeni_app;
    REVOKE ALL ON FUNCTION
      document_migration_audit_capability_active(text) FROM opengeni_app;
    REVOKE ALL ON FUNCTION
      assert_document_migration_audit_authority(jsonb) FROM opengeni_app;
    REVOKE ALL ON TABLE document_migration_audit_capabilities FROM opengeni_app;
  END IF;
END;
$document_migration_audit_runtime_grants$;

COMMENT ON TABLE document_migration_audit_capabilities IS
  'Target-local exact-token capabilities for read-only Document migration audit projections.';
