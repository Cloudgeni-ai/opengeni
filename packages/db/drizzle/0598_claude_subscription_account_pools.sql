-- deployment-mode: maintenance
-- Activate individual Claude accounts. Stop every old API and worker before
-- applying this codec-aware cutover; never restart a pre-cutover binary.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $claude_pool_drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF to_regclass('pg_temp.claude_pool_conversion_0587') IS NULL THEN
    RAISE EXCEPTION '0598 requires the codec-aware TypeScript migration runner' USING ERRCODE = '55000';
  END IF;
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0598 requires explicit application database roles' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR octet_length(item #>> '{}') NOT BETWEEN 1 AND 63
      OR item #>> '{}' <> btrim(item #>> '{}')
  ) THEN RAISE EXCEPTION '0598 received invalid application roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r.value = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0598 requires drained application sessions' USING ERRCODE = '55000';
  END IF;
END $claude_pool_drain$;


-- These are a closed, migration-owned set of objects, not application input.
-- Copy the complete current contract, including foreign keys, NULLS NOT
-- DISTINCT indexes, capability policies and mutation guards. LIKE alone does
-- not preserve foreign keys, policies, triggers or runtime privileges.
DO $claude_pool_tables$
DECLARE
  data_schema text := current_schema();
  source_name text;
  target_name text;
  source_schema text;
  source_oid oid;
  item record;
  ddl text;
BEGIN
  FOREACH source_name IN ARRAY ARRAY[
    'xai_subscription_runtime_capabilities',
    'xai_subscription_credentials', 'xai_rotation_settings',
    'xai_credential_leases', 'xai_session_account_pins', 'xai_capacity_waiters'
  ] LOOP
    source_schema := CASE WHEN source_name = 'xai_subscription_runtime_capabilities'
      THEN 'opengeni_private' ELSE data_schema END;
    target_name := replace(source_name, 'xai_', 'claude_');
    EXECUTE format('CREATE TABLE %I.%I (LIKE %I.%I INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING IDENTITY INCLUDING STORAGE)',
      source_schema, target_name, source_schema, source_name);
    EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC', source_schema, target_name);
  END LOOP;

  FOREACH source_name IN ARRAY ARRAY[
    'xai_subscription_runtime_capabilities',
    'xai_subscription_credentials', 'xai_rotation_settings',
    'xai_credential_leases', 'xai_session_account_pins', 'xai_capacity_waiters'
  ] LOOP
    source_schema := CASE WHEN source_name = 'xai_subscription_runtime_capabilities'
      THEN 'opengeni_private' ELSE data_schema END;
    target_name := replace(source_name, 'xai_', 'claude_');
    source_oid := format('%I.%I', source_schema, source_name)::regclass;
    FOR item IN SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid = source_oid
      ORDER BY CASE WHEN contype = 'f' THEN 1 ELSE 0 END, conname
    LOOP
      EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s', source_schema, target_name,
        replace(item.conname, 'xai_', 'claude_'), replace(item.definition, 'xai_', 'claude_'));
    END LOOP;
    FOR item IN SELECT pg_get_indexdef(indexrelid) AS definition
      FROM pg_index idx WHERE indrelid = source_oid
        AND NOT EXISTS (SELECT 1 FROM pg_constraint con
          WHERE con.conindid = idx.indexrelid AND con.conrelid = source_oid AND con.contype IN ('p', 'u', 'x'))
      ORDER BY indexrelid
    LOOP
      EXECUTE replace(item.definition, 'xai_', 'claude_');
    END LOOP;
  END LOOP;
END
$claude_pool_tables$;

DO $claude_pool_functions$
DECLARE
  data_schema text := current_schema();
  routine text;
  definition text;
  source_schema text;
BEGIN
  FOREACH routine IN ARRAY ARRAY[
    'xai_provider_account_authority_snapshot_v1_valid(jsonb)',
    'xai_subscription_authority_live(uuid,uuid,text,uuid,text,uuid,uuid,bigint)',
    'xai_subscription_pool_visible(uuid,uuid,text,text,uuid)',
    'create_xai_subscription_credential(uuid,uuid,text,text,text,text,text,text,text,timestamptz)',
    'resolve_xai_authority_pool(uuid,uuid,text,jsonb)',
    'revalidate_xai_subscription_authority(uuid,text,uuid,jsonb)',
    'disconnect_xai_subscription_credential(uuid,uuid,text,uuid,jsonb)',
    'prevent_xai_authority_mutation()', 'prevent_xai_snapshot_mutation()',
    'enforce_xai_credential_pool_reference()',
    'enforce_xai_organization_runtime_update()', 'prevent_organization_xai_live_disconnect()'
  ] LOOP
    source_schema := CASE WHEN routine LIKE 'enforce_xai_%'
      OR routine LIKE 'prevent_organization_xai_%' THEN 'opengeni_private' ELSE data_schema END;
    definition := pg_get_functiondef(format('%I.%s', source_schema, routine)::regprocedure);
    definition := replace(replace(replace(definition, 'xai_', 'claude_'), 'xAI', 'Claude'), 'SuperGrok', 'Claude');
    -- Claude OAuth renews a rotating token pair within the same account
    -- generation. Explicit reconnect/replacement increments it separately.
    IF routine = 'enforce_xai_organization_runtime_update()' THEN
      IF position('NEW.version IS DISTINCT FROM OLD.version + 1' IN definition) = 0 THEN
        RAISE EXCEPTION 'subscription refresh contract changed' USING ERRCODE = '55000';
      END IF;
      definition := replace(definition, 'NEW.version IS DISTINCT FROM OLD.version + 1',
        'NEW.version IS DISTINCT FROM OLD.version');
    END IF;
    EXECUTE definition;
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC', source_schema, replace(routine, 'xai_', 'claude_'));
  END LOOP;
END
$claude_pool_functions$;

DO $claude_pool_policies$
DECLARE
  data_schema text := current_schema();
  table_name text;
  item record;
  target_name text;
  roles_sql text;
  ddl text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'organization_memberships', 'organization_user_resource_authorities',
    'xai_subscription_credentials', 'xai_rotation_settings',
    'xai_credential_leases', 'xai_session_account_pins', 'xai_capacity_waiters'
  ] LOOP
    target_name := replace(table_name, 'xai_', 'claude_');
    FOR item IN SELECT polname, polpermissive, polcmd,
      pg_get_expr(polqual, polrelid) AS using_expr,
      pg_get_expr(polwithcheck, polrelid) AS check_expr, polroles
      FROM pg_policy WHERE polrelid = format('%I.%I', data_schema, table_name)::regclass
        AND (table_name LIKE 'xai_%' OR polname LIKE 'xai_subscription_capability_%')
      ORDER BY polname
    LOOP
      SELECT string_agg(CASE WHEN role_id = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(role_id)) END, ', ')
        INTO roles_sql FROM unnest(item.polroles) role_id;
      ddl := format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s',
        replace(item.polname, 'xai_', 'claude_'), data_schema, target_name,
        CASE WHEN item.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
        CASE item.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
          WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' WHEN '*' THEN 'ALL' END,
        roles_sql);
      IF item.using_expr IS NOT NULL THEN ddl := ddl || ' USING (' || replace(item.using_expr, 'xai_', 'claude_') || ')'; END IF;
      IF item.check_expr IS NOT NULL THEN ddl := ddl || ' WITH CHECK (' || replace(item.check_expr, 'xai_', 'claude_') || ')'; END IF;
      EXECUTE ddl;
    END LOOP;
    IF table_name LIKE 'xai_%' THEN
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', data_schema, target_name);
      EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', data_schema, target_name);
    END IF;
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY[
    'xai_subscription_credentials', 'xai_rotation_settings', 'xai_credential_leases',
    'xai_session_account_pins', 'xai_capacity_waiters'
  ] LOOP
    FOR item IN SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
      WHERE tgrelid = format('%I.%I', data_schema, table_name)::regclass AND NOT tgisinternal
      ORDER BY tgname
    LOOP
      EXECUTE replace(item.definition, 'xai_', 'claude_');
    END LOOP;
  END LOOP;
END
$claude_pool_policies$;

DO $claude_accepted_authority$
DECLARE
  data_schema text := current_schema();
  table_name text;
  column_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['sessions', 'session_turns', 'scheduled_tasks',
    'session_system_updates', 'session_system_update_outbox',
    'scheduled_task_revision_authorities'] LOOP
    column_name := CASE WHEN table_name = 'sessions'
      THEN 'initial_claude_provider_account_authority_snapshot'
      ELSE 'claude_provider_account_authority_snapshot' END;
    EXECUTE format('ALTER TABLE %I.%I ADD COLUMN %I jsonb NOT NULL DEFAULT ''{"version":1,"scope":"workspace"}''::jsonb,
      ADD CONSTRAINT %I CHECK (%I.claude_provider_account_authority_snapshot_v1_valid(%I))',
      data_schema, table_name, column_name, table_name || '_claude_authority_snapshot_chk', data_schema, column_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OF %I ON %I.%I
      FOR EACH ROW EXECUTE FUNCTION %I.prevent_claude_snapshot_mutation()',
      table_name || '_claude_authority_lock_trg', column_name, data_schema, table_name, data_schema);
  END LOOP;
END
$claude_accepted_authority$;

CREATE TABLE claude_subscription_account_usage (
  credential_id uuid PRIMARY KEY REFERENCES claude_subscription_credentials(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  credential_version integer NOT NULL CONSTRAINT claude_subscription_account_usage_generation_chk CHECK (credential_version > 0),
  snapshot jsonb NOT NULL,
  model_cooldowns jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claude_subscription_account_usage_account_fk
    FOREIGN KEY (account_id, credential_id)
    REFERENCES claude_subscription_credentials(account_id, id) ON DELETE CASCADE
);
ALTER TABLE claude_subscription_account_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE claude_subscription_account_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY claude_usage_account_scope ON claude_subscription_account_usage FOR ALL
  USING (account_id = NULLIF(current_setting('opengeni.account_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM claude_subscription_credentials credential
      WHERE credential.id = credential_id AND credential.account_id = claude_subscription_account_usage.account_id))
  WITH CHECK (account_id = NULLIF(current_setting('opengeni.account_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM claude_subscription_credentials credential
      WHERE credential.id = credential_id AND credential.account_id = claude_subscription_account_usage.account_id));

-- Retain the prior claim signature for historical catalog compatibility.
-- The new worker reads the additional accepted authority through a versioned
-- routine, retaining the installed claim's full row shape and lock ordering.
DO $claude_outbox_claim$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('opengeni_private.claim_session_system_update_outbox(integer)'::regprocedure);
  IF strpos(definition, 'xai_provider_account_authority_snapshot jsonb') = 0
    OR strpos(definition, 'o.xai_provider_account_authority_snapshot') = 0
    OR strpos(definition, 'ORDER BY c.created_at, c.id') = 0 THEN
    RAISE EXCEPTION '0598 outbox claim prerequisite drift' USING ERRCODE = '55000';
  END IF;
  definition := replace(definition, 'FUNCTION opengeni_private.claim_session_system_update_outbox(',
    'FUNCTION opengeni_private.claim_session_system_update_outbox_v2(');
  definition := replace(definition, 'xai_provider_account_authority_snapshot jsonb',
    'xai_provider_account_authority_snapshot jsonb, claude_provider_account_authority_snapshot jsonb');
  definition := replace(definition, 'o.xai_provider_account_authority_snapshot',
    'o.xai_provider_account_authority_snapshot, o.claude_provider_account_authority_snapshot');
  EXECUTE definition;
END $claude_outbox_claim$;
REVOKE ALL ON FUNCTION opengeni_private.claim_session_system_update_outbox_v2(integer) FROM PUBLIC;

-- Only the migration owner opens these exact tables. Application RLS remains
-- enabled throughout. Preserve the original FORCE flags and trigger modes;
-- transaction rollback restores them even if credential decoding fails.
CREATE TEMP TABLE claude_pool_relations_0587 AS
  SELECT c.oid, c.relforcerowsecurity, c.relrowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relname IN (
    'connections', 'organization_model_provider_connections',
    'claude_subscription_credentials', 'claude_rotation_settings', 'claude_subscription_account_usage',
    'sessions', 'session_turns', 'scheduled_tasks', 'scheduled_task_runs',
    'session_system_updates', 'session_system_update_outbox',
    'scheduled_task_revision_authorities', 'scheduled_task_personal_resource_authorities',
    'scheduled_task_connection_authority_snapshots', 'scheduled_task_run_personal_resource_admissions',
    'scheduled_task_run_connection_authority_snapshots'
  );
CREATE TEMP TABLE claude_pool_triggers_0587 AS
  SELECT t.tgrelid, t.tgname, t.tgenabled FROM pg_trigger t
  JOIN claude_pool_relations_0587 r ON r.oid = t.tgrelid WHERE NOT t.tgisinternal;
DO $claude_pool_owner_window$
DECLARE item record;
BEGIN
  IF EXISTS (SELECT 1 FROM claude_pool_relations_0587 r JOIN pg_class c ON c.oid = r.oid
    WHERE c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION '0598 requires the schema owner' USING ERRCODE = '55000';
  END IF;
  FOR item IN SELECT * FROM claude_pool_relations_0587 ORDER BY oid LOOP
    EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', item.oid::regclass);
  END LOOP;
  FOR item IN SELECT * FROM claude_pool_triggers_0587 WHERE tgenabled <> 'D' LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', item.tgrelid::regclass, item.tgname);
  END LOOP;
END $claude_pool_owner_window$;
ALTER TABLE "connections" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_model_provider_connections" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "claude_subscription_credentials" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "claude_rotation_settings" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "claude_subscription_account_usage" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "sessions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_turns" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_tasks" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_runs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_system_updates" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_system_update_outbox" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_revision_authorities" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_personal_resource_authorities" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_connection_authority_snapshots" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_run_personal_resource_admissions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_run_connection_authority_snapshots" NO FORCE ROW LEVEL SECURITY;
DO $claude_pool_source_preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM connections WHERE metadata->>'credentialRole' = 'claude_subscription'
    AND status = 'active' AND (subject_id IS NOT NULL OR authority_scope <> 'workspace'
      OR provider_domain <> 'api.anthropic.com' OR kind <> 'api_key')) THEN
    RAISE EXCEPTION '0598 refuses ambiguous legacy Claude ownership' USING ERRCODE = '55000';
  END IF;
END $claude_pool_source_preflight$;

-- opengeni:claude-subscription-pool-copy-v1

DO $claude_pool_codec_receipt$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_temp.claude_pool_conversion_0587 WHERE completed) THEN
    RAISE EXCEPTION '0598 credential conversion is incomplete' USING ERRCODE = '55000';
  END IF;
END $claude_pool_codec_receipt$;

-- Derive new scope from the producer's accepted executable identity. Never
-- resolve today's pool, organization membership, or session creator here.
CREATE FUNCTION pg_temp.claude_pool_scope_0587(policy jsonb, model text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $
BEGIN
  IF policy IS NOT NULL AND policy <> 'null'::jsonb THEN
    IF jsonb_typeof(policy) <> 'object' OR policy->>'schemaVersion' IS DISTINCT FROM '1'
      OR jsonb_typeof(policy->'providerId') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Claude pool conversion refuses an invalid accepted provider policy' USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object('version', 1, 'scope', CASE WHEN policy->>'providerId' = 'organization-claude-subscription' THEN 'organization' ELSE 'workspace' END);
  END IF;
  RETURN jsonb_build_object('version', 1, 'scope', CASE WHEN model LIKE 'organization-claude-subscription/%' THEN 'organization' ELSE 'workspace' END);
END
$;
UPDATE sessions SET initial_claude_provider_account_authority_snapshot =
  pg_temp.claude_pool_scope_0587(metadata->'turnExecutionPolicyV1', model);
UPDATE session_turns SET claude_provider_account_authority_snapshot =
  pg_temp.claude_pool_scope_0587(metadata->'turnExecutionPolicyV1', model);
-- A child with no initial policy retains its exact parent turn's authority.
UPDATE sessions s SET initial_claude_provider_account_authority_snapshot = t.claude_provider_account_authority_snapshot
  FROM session_turns t WHERE s.parent_turn_id = t.id AND s.parent_session_id = t.session_id
    AND s.account_id = t.account_id AND s.workspace_id = t.workspace_id
    AND s.metadata->'turnExecutionPolicyV1' IS NULL;

CREATE TEMP TABLE claude_pool_task_digests_0587 AS
  SELECT id, account_id, workspace_id, authority_revision, execution_digest FROM scheduled_tasks;
UPDATE scheduled_tasks SET claude_provider_account_authority_snapshot =
  pg_temp.claude_pool_scope_0587(metadata->'turnExecutionPolicyV1', agent_config->>'model');
UPDATE scheduled_tasks task SET execution_digest = scheduled_task_execution_digest(task);
-- Rebind only the exact retained task revision and old digest. Historical
-- revisions remain historical; no live authority is reconstructed here.
UPDATE scheduled_task_revision_authorities a SET execution_digest = task.execution_digest,
  claude_provider_account_authority_snapshot = task.claude_provider_account_authority_snapshot
  FROM scheduled_tasks task JOIN claude_pool_task_digests_0587 prior ON prior.id = task.id
  WHERE a.task_id = task.id AND a.account_id = task.account_id AND a.workspace_id = task.workspace_id
    AND a.task_authority_revision = prior.authority_revision AND a.execution_digest = prior.execution_digest;
UPDATE scheduled_task_personal_resource_authorities a SET execution_digest = task.execution_digest
  FROM scheduled_tasks task JOIN claude_pool_task_digests_0587 prior ON prior.id = task.id
  WHERE a.task_id = task.id AND a.account_id = task.account_id AND a.workspace_id = task.workspace_id
    AND a.task_authority_revision = prior.authority_revision AND a.execution_digest = prior.execution_digest;
WITH rewritten AS (
  SELECT a.task_id, a.task_authority_revision, a.server_id, task.execution_digest,
    jsonb_set(a.canonical_snapshot, '{executionDigest}', to_jsonb(task.execution_digest), false) AS canonical
  FROM scheduled_task_connection_authority_snapshots a
  JOIN scheduled_tasks task ON task.id = a.task_id AND task.account_id = a.account_id AND task.workspace_id = a.workspace_id
  JOIN claude_pool_task_digests_0587 prior ON prior.id = task.id AND prior.account_id = task.account_id
  WHERE a.task_authority_revision = prior.authority_revision AND a.execution_digest = prior.execution_digest
    AND a.canonical_snapshot->>'executionDigest' = prior.execution_digest
)
UPDATE scheduled_task_connection_authority_snapshots a
  SET execution_digest = r.execution_digest, canonical_snapshot = r.canonical,
    snapshot_digest = digest(convert_to(r.canonical::text, 'UTF8'), 'sha256')
  FROM rewritten r WHERE a.task_id = r.task_id AND a.task_authority_revision = r.task_authority_revision AND a.server_id = r.server_id;
CREATE TEMP TABLE claude_pool_run_snapshots_0587 ON COMMIT DROP AS
  SELECT run.id, run.account_id, run.workspace_id, run.task_id, run.task_authority_revision,
    run.task_execution_digest AS previous_task_digest,
    CASE WHEN run.task_authority_revision = prior.authority_revision
      AND run.task_execution_digest = prior.execution_digest
      AND run.accepted_execution_snapshot#>>'{task,executionDigest}' = prior.execution_digest
      THEN task.execution_digest ELSE run.task_execution_digest END AS task_digest,
    jsonb_set(jsonb_set(
      CASE WHEN run.task_authority_revision = prior.authority_revision
        AND run.task_execution_digest = prior.execution_digest
        AND run.accepted_execution_snapshot#>>'{task,executionDigest}' = prior.execution_digest
        THEN jsonb_set(run.accepted_execution_snapshot, '{task,executionDigest}', to_jsonb(task.execution_digest))
        ELSE run.accepted_execution_snapshot END,
      '{claudeProviderAccountAuthoritySnapshot}', pg_temp.claude_pool_scope_0587(
        run.accepted_execution_snapshot->'turnExecutionPolicy', run.accepted_execution_snapshot->>'resolvedModel')),
      '{claudeAuthoritySubjectId}', 'null'::jsonb) AS snapshot
  FROM scheduled_task_runs run
  JOIN scheduled_tasks task ON task.id = run.task_id AND task.account_id = run.account_id AND task.workspace_id = run.workspace_id
  JOIN claude_pool_task_digests_0587 prior ON prior.id = task.id AND prior.account_id = task.account_id
  WHERE run.accepted_execution_snapshot IS NOT NULL;
UPDATE scheduled_task_runs run SET accepted_execution_snapshot = r.snapshot,
  accepted_execution_digest = encode(digest(convert_to(r.snapshot::text, 'UTF8'), 'sha256'), 'hex'),
  task_execution_digest = r.task_digest
  FROM claude_pool_run_snapshots_0587 r WHERE run.id = r.id;
UPDATE scheduled_task_run_personal_resource_admissions a SET execution_digest = r.task_digest
  FROM claude_pool_run_snapshots_0587 r
  WHERE a.run_id = r.id AND a.task_id = r.task_id AND a.account_id = r.account_id AND a.workspace_id = r.workspace_id
    AND a.task_authority_revision = r.task_authority_revision AND a.execution_digest = r.previous_task_digest;
WITH rewritten AS (
  SELECT a.run_id, a.server_id, r.task_digest,
    jsonb_set(a.canonical_snapshot, '{executionDigest}', to_jsonb(r.task_digest), false) AS canonical
  FROM scheduled_task_run_connection_authority_snapshots a
  JOIN claude_pool_run_snapshots_0587 r ON r.id = a.run_id AND r.task_id = a.task_id
    AND r.account_id = a.account_id AND r.workspace_id = a.workspace_id
    AND r.task_authority_revision = a.task_authority_revision
  WHERE a.execution_digest = r.previous_task_digest AND a.canonical_snapshot->>'executionDigest' = r.previous_task_digest
)
UPDATE scheduled_task_run_connection_authority_snapshots a SET execution_digest = r.task_digest,
  canonical_snapshot = r.canonical, snapshot_digest = digest(convert_to(r.canonical::text, 'UTF8'), 'sha256')
  FROM rewritten r WHERE a.run_id = r.run_id AND a.server_id = r.server_id;
UPDATE session_system_updates u SET claude_provider_account_authority_snapshot =
  pg_temp.claude_pool_scope_0587(u.payload#>'{policy,turnExecutionPolicy}', u.payload#>>'{policy,model}');
UPDATE session_system_update_outbox o SET claude_provider_account_authority_snapshot =
  pg_temp.claude_pool_scope_0587(o.payload#>'{policy,turnExecutionPolicy}', o.payload#>>'{policy,model}');
UPDATE session_system_updates u SET claude_provider_account_authority_snapshot =
  run.accepted_execution_snapshot->'claudeProviderAccountAuthoritySnapshot'
  FROM scheduled_task_runs run WHERE u.scheduled_task_run_id = run.id AND u.account_id = run.account_id
    AND u.workspace_id = run.workspace_id AND run.accepted_execution_snapshot IS NOT NULL;
UPDATE session_system_update_outbox o SET claude_provider_account_authority_snapshot =
  parent.claude_provider_account_authority_snapshot
  FROM sessions child JOIN session_turns parent ON parent.id = child.parent_turn_id
    AND parent.session_id = child.parent_session_id AND parent.account_id = child.account_id
    AND parent.workspace_id = child.workspace_id
  WHERE o.source_session_id = child.id AND o.target_session_id = parent.session_id
    AND o.account_id = child.account_id AND o.workspace_id = child.workspace_id;
UPDATE session_system_updates u SET claude_provider_account_authority_snapshot =
  o.claude_provider_account_authority_snapshot FROM session_system_update_outbox o
  WHERE o.target_session_id = u.session_id AND o.account_id = u.account_id
    AND o.workspace_id = u.workspace_id AND o.dedupe_key = u.dedupe_key;

-- Validate deferred foreign keys before restoring trigger modes on changed tables.
SET CONSTRAINTS ALL IMMEDIATE;

DO $claude_pool_restore$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM claude_pool_triggers_0587 LOOP
    EXECUTE format('ALTER TABLE %s %s TRIGGER %I', item.tgrelid::regclass,
      CASE item.tgenabled WHEN 'A' THEN 'ENABLE ALWAYS' WHEN 'R' THEN 'ENABLE REPLICA'
        WHEN 'D' THEN 'DISABLE' ELSE 'ENABLE' END, item.tgname);
  END LOOP;
  FOR item IN SELECT * FROM claude_pool_relations_0587 WHERE relforcerowsecurity LOOP
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', item.oid::regclass);
  END LOOP;
END $claude_pool_restore$;

CREATE FUNCTION reject_legacy_claude_subscription_credentials() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME = 'connections' THEN
    IF NEW.metadata->>'credentialRole' = 'claude_subscription'
      OR (TG_OP = 'UPDATE' AND OLD.metadata->>'credentialRole' = 'claude_subscription') THEN
      IF NEW.status <> 'revoked' OR NEW.credential_encrypted <> ''
        OR NEW.metadata->>'credentialRole' IS DISTINCT FROM 'claude_subscription' THEN
        RAISE EXCEPTION 'Claude subscriptions use individual accounts' USING ERRCODE = '0A000';
      END IF;
    END IF;
  ELSIF NEW.provider_kind = 'claude_subscription'
    OR (TG_OP = 'UPDATE' AND OLD.provider_kind = 'claude_subscription') THEN
    IF NEW.status <> 'revoked' OR NEW.credential_encrypted <> '' OR NEW.provider_kind <> 'claude_subscription' THEN
      RAISE EXCEPTION 'Claude subscriptions use individual accounts' USING ERRCODE = '0A000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reject_legacy_claude_subscription_credentials BEFORE INSERT OR UPDATE ON connections
  FOR EACH ROW EXECUTE FUNCTION reject_legacy_claude_subscription_credentials();
CREATE TRIGGER reject_legacy_claude_subscription_credentials BEFORE INSERT OR UPDATE ON organization_model_provider_connections
  FOR EACH ROW EXECUTE FUNCTION reject_legacy_claude_subscription_credentials();
REVOKE ALL ON FUNCTION reject_legacy_claude_subscription_credentials() FROM PUBLIC;

-- Value-free startup interlock exists only after conversion and restoration.
CREATE FUNCTION opengeni_private.claude_subscription_pool_protocol_v1_active() RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION opengeni_private.claude_subscription_pool_protocol_v1_active() FROM PUBLIC;
