-- deployment-mode: maintenance
-- M4 R: retire the legacy per-provider subscription decision routines, the
-- triggers and policies that call them, and the Codex-named twins of the
-- provider-neutral routines (design docs/design/subscription-core-2026-10-07.md,
-- 5.3 "R. Retirement" and the 0713 note "Kept until retirement").
--
-- Run it in a drained maintenance window after the SuperGrok (0719) and
-- Claude (0720) cutovers: stop every API, control-worker and turn-worker,
-- pass the complete runtime-login list, apply, then start only a release
-- that contains this migration. Never roll it back: recovery is fix-forward.
--
-- Kept on purpose: historical migrations, the legacy tables and columns (M6),
-- the v1 CHECK validators (*_provider_account_authority_snapshot_v1_valid),
-- the column-immutability functions and triggers (prevent_*_snapshot_mutation),
-- reject_legacy_claude_subscription_credentials and its triggers, every
-- receipt function (including claude_subscription_pool_protocol_v1_active),
-- the X3/C3 *_closed restrictive policies, the still-live Codex routines and
-- list_organization_codex_workspace_ids (the legacy organization pool wake
-- still calls it). The per-provider runtime-capability tables stay until M6;
-- nothing reads or writes them once their policies and routines are gone.
--
-- Every drop names its object exactly and never cascades. The preflight
-- below changes nothing and refuses, with a content-free error, unless the
-- application sessions are drained, the Codex, SuperGrok and Claude cutover
-- receipts are committed, every retired object exists exactly as listed (no
-- other overload of a retired routine name, every trigger calling its listed
-- routine) and nothing that stays depends on one of them. The whole file is
-- one transaction, so a refusal or a failed drop leaves the schema unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $retirement_preflight$
DECLARE
  data_schema text := current_schema();
  roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
  -- Every routine this migration drops, by exact signature: the target
  -- schema's, then opengeni_private's, then opengeni_subscription_internal's.
  target_routines text[] := ARRAY[
    'create_xai_subscription_credential(uuid, uuid, text, text, text, text, text, text, text, timestamp with time zone)',
    'disconnect_xai_subscription_credential(uuid, uuid, text, uuid, jsonb)',
    'resolve_xai_authority_pool(uuid, uuid, text, jsonb)',
    'revalidate_xai_subscription_authority(uuid, text, uuid, jsonb)',
    'xai_subscription_authority_live(uuid, uuid, text, uuid, text, uuid, uuid, bigint)',
    'xai_subscription_pool_visible(uuid, uuid, text, text, uuid)',
    'prevent_xai_authority_mutation()',
    'create_claude_subscription_credential(uuid, uuid, text, text, text, text, text, text, text, timestamp with time zone)',
    'disconnect_claude_subscription_credential(uuid, uuid, text, uuid, jsonb)',
    'resolve_claude_authority_pool(uuid, uuid, text, jsonb)',
    'revalidate_claude_subscription_authority(uuid, text, uuid, jsonb)',
    'claude_subscription_authority_live(uuid, uuid, text, uuid, text, uuid, uuid, bigint)',
    'claude_subscription_pool_visible(uuid, uuid, text, text, uuid)',
    'prevent_claude_authority_mutation()'
  ];
  private_routines text[] := ARRAY[
    'enforce_xai_credential_pool_reference()',
    'enforce_xai_organization_runtime_update()',
    'prevent_organization_xai_live_disconnect()',
    'enforce_claude_credential_pool_reference()',
    'enforce_claude_organization_runtime_update()',
    'prevent_organization_claude_live_disconnect()',
    'begin_subscription_codex_refresh(uuid, uuid, uuid, uuid, text, text, uuid, text, bigint)',
    'persist_subscription_codex_refresh(uuid, uuid, uuid, uuid, uuid, bigint, text, timestamp with time zone, timestamp with time zone)',
    'fail_subscription_codex_refresh(uuid, uuid, uuid, uuid, uuid, bigint, text)',
    'quarantine_subscription_codex_connection(uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, text, text, timestamp with time zone)',
    'recover_subscription_codex_connection_health(uuid, uuid, uuid, uuid)',
    'persist_subscription_codex_refresh_with_plan(uuid, uuid, uuid, uuid, uuid, bigint, text, timestamp with time zone, timestamp with time zone, text)',
    'subscription_codex_acceptance_authority_v2(uuid, uuid, uuid, text)',
    'read_subscription_codex_connection_credential(uuid, uuid, uuid, uuid, uuid, text, bigint)',
    'begin_subscription_codex_connection_refresh(uuid, uuid, uuid, uuid, uuid, text, bigint)',
    'persist_subscription_codex_connection_refresh(uuid, uuid, uuid, bigint, text, timestamp with time zone, timestamp with time zone)',
    'fail_subscription_codex_connection_refresh(uuid, uuid, uuid, bigint, text)',
    'connect_subscription_codex_personal(uuid, uuid, text, text, text, text, text, jsonb, timestamp with time zone, timestamp with time zone, text, text, text)',
    'disconnect_subscription_codex_connection(uuid, uuid, text, uuid)',
    'subscription_codex_personal_connections(uuid, uuid, text)',
    'subscription_codex_task_authority_v2(uuid, uuid, uuid, text)',
    'subscription_codex_revision_authority_v2(uuid, uuid, uuid, bigint)',
    'manage_subscription_codex_personal(uuid, uuid, text, uuid, text, text, boolean, integer)',
    'subscription_codex_reach(uuid, uuid)',
    'set_subscription_codex_reach(uuid, uuid, boolean, boolean)',
    'subscription_codex_connection_target(uuid, uuid, uuid, uuid, uuid, text, bigint)',
    'apply_subscription_codex_auto_assignments(uuid, uuid, boolean)'
  ];
  internal_routines text[] := ARRAY['subscription_codex_writer_context(uuid, uuid, text)'];
  -- Every policy and trigger this migration drops, as table.name in the
  -- target schema.
  retired_policies text[] := ARRAY[
    'xai_subscription_credentials.xai_subscription_scope',
    'xai_rotation_settings.xai_subscription_pool_scope',
    'xai_credential_leases.xai_subscription_pool_scope',
    'xai_session_account_pins.xai_subscription_pool_scope',
    'xai_capacity_waiters.xai_subscription_pool_scope',
    'claude_subscription_credentials.claude_subscription_scope',
    'claude_rotation_settings.claude_subscription_pool_scope',
    'claude_credential_leases.claude_subscription_pool_scope',
    'claude_session_account_pins.claude_subscription_pool_scope',
    'claude_capacity_waiters.claude_subscription_pool_scope',
    'claude_subscription_account_usage.claude_usage_account_scope',
    'organization_memberships.xai_subscription_capability_read',
    'organization_memberships.xai_subscription_membership_lock',
    'organization_memberships.claude_subscription_capability_read',
    'organization_memberships.claude_subscription_membership_lock',
    'organization_user_resource_authorities.xai_subscription_capability_insert',
    'organization_user_resource_authorities.xai_subscription_capability_read',
    'organization_user_resource_authorities.xai_subscription_capability_revoke',
    'organization_user_resource_authorities.claude_subscription_capability_insert',
    'organization_user_resource_authorities.claude_subscription_capability_read',
    'organization_user_resource_authorities.claude_subscription_capability_revoke'
  ];
  -- table.trigger.routine: the exact retired routine each trigger executes.
  retired_triggers text[] := ARRAY[
    'xai_subscription_credentials.xai_subscription_credentials_authority_immutable_trg.prevent_xai_authority_mutation',
    'xai_subscription_credentials.xai_organization_runtime_update_guard.enforce_xai_organization_runtime_update',
    'xai_subscription_credentials.xai_organization_live_disconnect_guard.prevent_organization_xai_live_disconnect',
    'xai_rotation_settings.xai_organization_rotation_update_guard.enforce_xai_organization_runtime_update',
    'xai_rotation_settings.xai_rotation_credential_pool_guard.enforce_xai_credential_pool_reference',
    'xai_credential_leases.xai_lease_credential_pool_guard.enforce_xai_credential_pool_reference',
    'xai_session_account_pins.xai_pin_credential_pool_guard.enforce_xai_credential_pool_reference',
    'claude_subscription_credentials.claude_subscription_credentials_authority_immutable_trg.prevent_claude_authority_mutation',
    'claude_subscription_credentials.claude_organization_runtime_update_guard.enforce_claude_organization_runtime_update',
    'claude_subscription_credentials.claude_organization_live_disconnect_guard.prevent_organization_claude_live_disconnect',
    'claude_rotation_settings.claude_organization_rotation_update_guard.enforce_claude_organization_runtime_update',
    'claude_rotation_settings.claude_rotation_credential_pool_guard.enforce_claude_credential_pool_reference',
    'claude_credential_leases.claude_lease_credential_pool_guard.enforce_claude_credential_pool_reference',
    'claude_session_account_pins.claude_pin_credential_pool_guard.enforce_claude_credential_pool_reference'
  ];
  retired_routine_ids oid[];
  retired_policy_ids oid[];
  retired_trigger_ids oid[];
  retired_names text[];
  finding text;
BEGIN
  -- 1. Drained: no application session is connected to this database.
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0721 requires explicit application database roles' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR octet_length(item #>> '{}') NOT BETWEEN 1 AND 63
      OR item #>> '{}' <> btrim(item #>> '{}')
  ) THEN RAISE EXCEPTION '0721 received invalid application roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r.value = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0721 requires drained application sessions' USING ERRCODE = '55000';
  END IF;

  -- 2. Every provider is on the shared core: the Codex (0689), SuperGrok
  -- (0719) and Claude (0720) cutover receipts are committed. A fresh install
  -- has all three: 0689 seeds Codex's, and 0719 and 0720 write theirs on an
  -- empty database too.
  IF to_regprocedure('opengeni_private.subscription_provider_cutover_committed(text)') IS NULL THEN
    RAISE EXCEPTION '0721 requires the provider cutover receipts (0712)' USING ERRCODE = '55000';
  END IF;
  SELECT string_agg(provider, ', ' ORDER BY provider) INTO finding
  FROM unnest(ARRAY['codex', 'xai', 'claude']) provider
  WHERE NOT opengeni_private.subscription_provider_cutover_committed(provider);
  IF finding IS NOT NULL THEN
    RAISE EXCEPTION '0721 requires the committed cutover receipt of every provider; missing: %', finding
      USING ERRCODE = '55000';
  END IF;

  -- 3. Exact posture: every retired object exists exactly as listed.
  SELECT string_agg(signature, ', ' ORDER BY signature) INTO finding
  FROM (
    SELECT format('%I.%s', data_schema, signature) AS signature FROM unnest(target_routines) signature
    UNION ALL SELECT 'opengeni_private.' || signature FROM unnest(private_routines) signature
    UNION ALL SELECT 'opengeni_subscription_internal.' || signature FROM unnest(internal_routines) signature
  ) expected
  WHERE to_regprocedure(signature) IS NULL;
  IF finding IS NOT NULL THEN
    RAISE EXCEPTION '0721 found a retired routine missing or changed: %; see the runbook', finding
      USING ERRCODE = '55000';
  END IF;
  SELECT array_agg(to_regprocedure(signature)::oid), array_agg(DISTINCT split_part(split_part(signature, '(', 1), '.', -1))
  INTO retired_routine_ids, retired_names
  FROM (
    SELECT format('%I.%s', data_schema, signature) AS signature FROM unnest(target_routines) signature
    UNION ALL SELECT 'opengeni_private.' || signature FROM unnest(private_routines) signature
    UNION ALL SELECT 'opengeni_subscription_internal.' || signature FROM unnest(internal_routines) signature
  ) expected;
  -- No other overload of a retired routine name may survive the drop.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO finding
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN (data_schema, 'opengeni_private', 'opengeni_subscription_internal')
    AND p.proname = ANY(retired_names) AND NOT (p.oid = ANY(retired_routine_ids));
  IF finding IS NOT NULL THEN
    RAISE EXCEPTION '0721 found an unexpected overload of a retired routine: %; see the runbook', finding
      USING ERRCODE = '55000';
  END IF;
  SELECT string_agg(entry, ', ' ORDER BY entry) INTO finding
  FROM unnest(retired_policies) entry
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_policy policy JOIN pg_class relation ON relation.oid = policy.polrelid
    WHERE relation.relnamespace = data_schema::regnamespace
      AND relation.relname = split_part(entry, '.', 1) AND policy.polname = split_part(entry, '.', 2));
  IF finding IS NOT NULL THEN
    RAISE EXCEPTION '0721 found a retired policy missing: %; see the runbook', finding USING ERRCODE = '55000';
  END IF;
  SELECT array_agg(policy.oid) INTO retired_policy_ids
  FROM unnest(retired_policies) entry
  JOIN pg_class relation ON relation.relnamespace = data_schema::regnamespace
    AND relation.relname = split_part(entry, '.', 1)
  JOIN pg_policy policy ON policy.polrelid = relation.oid AND policy.polname = split_part(entry, '.', 2);
  -- A retired trigger must exist on its table and execute its listed routine.
  SELECT string_agg(entry, ', ' ORDER BY entry) INTO finding
  FROM unnest(retired_triggers) entry
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger trigger_row JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
      JOIN pg_proc routine ON routine.oid = trigger_row.tgfoid
    WHERE relation.relnamespace = data_schema::regnamespace AND NOT trigger_row.tgisinternal
      AND relation.relname = split_part(entry, '.', 1) AND trigger_row.tgname = split_part(entry, '.', 2)
      AND trigger_row.tgfoid = ANY(retired_routine_ids) AND routine.proname = split_part(entry, '.', 3));
  IF finding IS NOT NULL THEN
    RAISE EXCEPTION '0721 found a retired trigger missing or changed: %; see the runbook', finding
      USING ERRCODE = '55000';
  END IF;
  SELECT array_agg(trigger_row.oid) INTO retired_trigger_ids
  FROM unnest(retired_triggers) entry
  JOIN pg_class relation ON relation.relnamespace = data_schema::regnamespace
    AND relation.relname = split_part(entry, '.', 1)
  JOIN pg_trigger trigger_row ON trigger_row.tgrelid = relation.oid
    AND trigger_row.tgname = split_part(entry, '.', 2) AND NOT trigger_row.tgisinternal;

  -- 4. A runtime login missing from the passed role list is not connected
  -- either: refuse every other client backend whose role may call a retired
  -- routine or write a table whose retired policies or triggers go. The
  -- owner's own sessions (serialized by the migration lock) and superusers
  -- are not runtime logins; trigger functions run without EXECUTE.
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN pg_roles login ON login.oid = activity.usesysid
    WHERE activity.datname = current_database() AND activity.pid <> pg_backend_pid()
      -- A non-superuser owner sees NULL for another role's backend_type.
      AND coalesce(activity.backend_type, 'client backend') = 'client backend'
      AND login.rolname <> current_user AND NOT login.rolsuper
      AND (EXISTS (SELECT 1 FROM pg_proc routine
          WHERE routine.oid = ANY(retired_routine_ids) AND routine.prorettype <> 'trigger'::regtype
            AND has_function_privilege(activity.usesysid, routine.oid, 'EXECUTE'))
        OR EXISTS (SELECT 1 FROM pg_class relation
          WHERE relation.relnamespace = data_schema::regnamespace
            AND relation.relname IN (
              SELECT split_part(entry, '.', 1) FROM unnest(retired_policies || retired_triggers) entry)
            AND (has_table_privilege(activity.usesysid, relation.oid, 'INSERT')
              OR has_table_privilege(activity.usesysid, relation.oid, 'UPDATE')
              OR has_table_privilege(activity.usesysid, relation.oid, 'DELETE'))))
  ) THEN
    RAISE EXCEPTION '0721 requires drained application sessions (a connected role outside the listed application roles can use a retired object)'
      USING ERRCODE = '55000';
  END IF;

  -- 5. Nothing that stays depends on a retired routine. Catalog dependencies
  -- (policies, triggers, views, defaults, constraints and SQL-standard
  -- bodies) are in pg_depend; PL/pgSQL and SQL-string bodies and policy
  -- expressions are searched by name, together with the retired policy and
  -- trigger names that dynamic SQL in a kept routine could use.
  SELECT string_agg(DISTINCT pg_describe_object(d.classid, d.objid, d.objsubid), ', ') INTO finding
  FROM pg_depend d
  WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = ANY(retired_routine_ids)
    AND NOT (d.classid = 'pg_proc'::regclass AND d.objid = ANY(retired_routine_ids))
    AND NOT (d.classid = 'pg_policy'::regclass AND d.objid = ANY(retired_policy_ids))
    AND NOT (d.classid = 'pg_trigger'::regclass AND d.objid = ANY(retired_trigger_ids));
  IF finding IS NOT NULL THEN
    RAISE EXCEPTION '0721 found a kept object that depends on a retired routine: %', finding
      USING ERRCODE = '2BP01';
  END IF;
  retired_names := retired_names
    || ARRAY(SELECT split_part(entry, '.', 2) FROM unnest(retired_policies) entry)
    || ARRAY(SELECT split_part(entry, '.', 2) FROM unnest(retired_triggers) entry);
  SELECT string_agg(DISTINCT dependent, ', ') INTO finding
  FROM (
    SELECT 'routine ' || p.oid::regprocedure::text AS dependent
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND NOT (p.oid = ANY(retired_routine_ids))
      AND EXISTS (SELECT 1 FROM unnest(retired_names) retired
        WHERE p.prosrc ~ ('\m' || retired || '\M'))
    UNION ALL
    SELECT 'policy ' || relation.relname || '.' || policy.polname
    FROM pg_policy policy JOIN pg_class relation ON relation.oid = policy.polrelid
    WHERE NOT (policy.oid = ANY(retired_policy_ids))
      AND EXISTS (SELECT 1 FROM unnest(retired_names) retired
        WHERE coalesce(pg_get_expr(policy.polqual, policy.polrelid), '') || ' '
          || coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid), '') ~ ('\m' || retired || '\M'))
  ) dependents;
  IF finding IS NOT NULL THEN
    RAISE EXCEPTION '0721 found a kept object that names a retired object: %', finding
      USING ERRCODE = '2BP01';
  END IF;
END
$retirement_preflight$;

-- 6. The policies that call the retired routines or read the retired
-- runtime-capability tables: the legacy factory tables' scope policies, the
-- Claude usage scope and the capability policies of the 0234/0598 protocol.
-- The factory tables keep FORCE RLS and their X3/C3 *_closed policies;
-- pins and waiters keep no permissive policy at all and so deny every
-- non-owner, the intended read-only end state until M6.
DROP POLICY xai_subscription_scope ON xai_subscription_credentials;
DROP POLICY xai_subscription_pool_scope ON xai_rotation_settings;
DROP POLICY xai_subscription_pool_scope ON xai_credential_leases;
DROP POLICY xai_subscription_pool_scope ON xai_session_account_pins;
DROP POLICY xai_subscription_pool_scope ON xai_capacity_waiters;
DROP POLICY claude_subscription_scope ON claude_subscription_credentials;
DROP POLICY claude_subscription_pool_scope ON claude_rotation_settings;
DROP POLICY claude_subscription_pool_scope ON claude_credential_leases;
DROP POLICY claude_subscription_pool_scope ON claude_session_account_pins;
DROP POLICY claude_subscription_pool_scope ON claude_capacity_waiters;
DROP POLICY claude_usage_account_scope ON claude_subscription_account_usage;
DROP POLICY xai_subscription_capability_read ON organization_memberships;
DROP POLICY xai_subscription_membership_lock ON organization_memberships;
DROP POLICY claude_subscription_capability_read ON organization_memberships;
DROP POLICY claude_subscription_membership_lock ON organization_memberships;
DROP POLICY xai_subscription_capability_insert ON organization_user_resource_authorities;
DROP POLICY xai_subscription_capability_read ON organization_user_resource_authorities;
DROP POLICY xai_subscription_capability_revoke ON organization_user_resource_authorities;
DROP POLICY claude_subscription_capability_insert ON organization_user_resource_authorities;
DROP POLICY claude_subscription_capability_read ON organization_user_resource_authorities;
DROP POLICY claude_subscription_capability_revoke ON organization_user_resource_authorities;

-- 7. The triggers that call the retired trigger functions (the 0234 and 0598
-- factory's pool-reference, organization-runtime, live-disconnect and
-- authority-immutability guards). The column-immutability triggers on
-- sessions, turns, system updates and scheduled tasks stay.
DROP TRIGGER xai_subscription_credentials_authority_immutable_trg ON xai_subscription_credentials;
DROP TRIGGER xai_organization_runtime_update_guard ON xai_subscription_credentials;
DROP TRIGGER xai_organization_live_disconnect_guard ON xai_subscription_credentials;
DROP TRIGGER xai_organization_rotation_update_guard ON xai_rotation_settings;
DROP TRIGGER xai_rotation_credential_pool_guard ON xai_rotation_settings;
DROP TRIGGER xai_lease_credential_pool_guard ON xai_credential_leases;
DROP TRIGGER xai_pin_credential_pool_guard ON xai_session_account_pins;
DROP TRIGGER claude_subscription_credentials_authority_immutable_trg ON claude_subscription_credentials;
DROP TRIGGER claude_organization_runtime_update_guard ON claude_subscription_credentials;
DROP TRIGGER claude_organization_live_disconnect_guard ON claude_subscription_credentials;
DROP TRIGGER claude_organization_rotation_update_guard ON claude_rotation_settings;
DROP TRIGGER claude_rotation_credential_pool_guard ON claude_rotation_settings;
DROP TRIGGER claude_lease_credential_pool_guard ON claude_credential_leases;
DROP TRIGGER claude_pin_credential_pool_guard ON claude_session_account_pins;

-- 8. The routines. The SuperGrok and Claude pool routines (writers,
-- resolvers, revalidators and the policy predicates), then their trigger
-- functions; then the Codex-named twins of the 0707 neutral routines, before
-- the owner-only internals only they call, and 0689's Codex apply routine,
-- which nothing has called since 0713.
DROP FUNCTION create_xai_subscription_credential(uuid, uuid, text, text, text, text, text, text, text, timestamp with time zone);
DROP FUNCTION disconnect_xai_subscription_credential(uuid, uuid, text, uuid, jsonb);
DROP FUNCTION resolve_xai_authority_pool(uuid, uuid, text, jsonb);
DROP FUNCTION revalidate_xai_subscription_authority(uuid, text, uuid, jsonb);
DROP FUNCTION xai_subscription_authority_live(uuid, uuid, text, uuid, text, uuid, uuid, bigint);
DROP FUNCTION xai_subscription_pool_visible(uuid, uuid, text, text, uuid);
DROP FUNCTION prevent_xai_authority_mutation();
DROP FUNCTION opengeni_private.enforce_xai_credential_pool_reference();
DROP FUNCTION opengeni_private.enforce_xai_organization_runtime_update();
DROP FUNCTION opengeni_private.prevent_organization_xai_live_disconnect();
DROP FUNCTION create_claude_subscription_credential(uuid, uuid, text, text, text, text, text, text, text, timestamp with time zone);
DROP FUNCTION disconnect_claude_subscription_credential(uuid, uuid, text, uuid, jsonb);
DROP FUNCTION resolve_claude_authority_pool(uuid, uuid, text, jsonb);
DROP FUNCTION revalidate_claude_subscription_authority(uuid, text, uuid, jsonb);
DROP FUNCTION claude_subscription_authority_live(uuid, uuid, text, uuid, text, uuid, uuid, bigint);
DROP FUNCTION claude_subscription_pool_visible(uuid, uuid, text, text, uuid);
DROP FUNCTION prevent_claude_authority_mutation();
DROP FUNCTION opengeni_private.enforce_claude_credential_pool_reference();
DROP FUNCTION opengeni_private.enforce_claude_organization_runtime_update();
DROP FUNCTION opengeni_private.prevent_organization_claude_live_disconnect();
DROP FUNCTION opengeni_private.begin_subscription_codex_refresh(uuid, uuid, uuid, uuid, text, text, uuid, text, bigint);
DROP FUNCTION opengeni_private.persist_subscription_codex_refresh(uuid, uuid, uuid, uuid, uuid, bigint, text, timestamp with time zone, timestamp with time zone);
DROP FUNCTION opengeni_private.fail_subscription_codex_refresh(uuid, uuid, uuid, uuid, uuid, bigint, text);
DROP FUNCTION opengeni_private.quarantine_subscription_codex_connection(uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, text, text, timestamp with time zone);
DROP FUNCTION opengeni_private.recover_subscription_codex_connection_health(uuid, uuid, uuid, uuid);
DROP FUNCTION opengeni_private.persist_subscription_codex_refresh_with_plan(uuid, uuid, uuid, uuid, uuid, bigint, text, timestamp with time zone, timestamp with time zone, text);
DROP FUNCTION opengeni_private.subscription_codex_acceptance_authority_v2(uuid, uuid, uuid, text);
DROP FUNCTION opengeni_private.read_subscription_codex_connection_credential(uuid, uuid, uuid, uuid, uuid, text, bigint);
DROP FUNCTION opengeni_private.begin_subscription_codex_connection_refresh(uuid, uuid, uuid, uuid, uuid, text, bigint);
DROP FUNCTION opengeni_private.persist_subscription_codex_connection_refresh(uuid, uuid, uuid, bigint, text, timestamp with time zone, timestamp with time zone);
DROP FUNCTION opengeni_private.fail_subscription_codex_connection_refresh(uuid, uuid, uuid, bigint, text);
DROP FUNCTION opengeni_private.connect_subscription_codex_personal(uuid, uuid, text, text, text, text, text, jsonb, timestamp with time zone, timestamp with time zone, text, text, text);
DROP FUNCTION opengeni_private.disconnect_subscription_codex_connection(uuid, uuid, text, uuid);
DROP FUNCTION opengeni_private.subscription_codex_personal_connections(uuid, uuid, text);
DROP FUNCTION opengeni_private.subscription_codex_task_authority_v2(uuid, uuid, uuid, text);
DROP FUNCTION opengeni_private.subscription_codex_revision_authority_v2(uuid, uuid, uuid, bigint);
DROP FUNCTION opengeni_private.manage_subscription_codex_personal(uuid, uuid, text, uuid, text, text, boolean, integer);
DROP FUNCTION opengeni_private.subscription_codex_reach(uuid, uuid);
DROP FUNCTION opengeni_private.set_subscription_codex_reach(uuid, uuid, boolean, boolean);
DROP FUNCTION opengeni_private.subscription_codex_connection_target(uuid, uuid, uuid, uuid, uuid, text, bigint);
DROP FUNCTION opengeni_subscription_internal.subscription_codex_writer_context(uuid, uuid, text);
DROP FUNCTION opengeni_private.apply_subscription_codex_auto_assignments(uuid, uuid, boolean);
