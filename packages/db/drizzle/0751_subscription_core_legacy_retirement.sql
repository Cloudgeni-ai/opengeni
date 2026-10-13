-- deployment-mode: maintenance
-- M4 R: retire the legacy per-provider subscription decision routines, the
-- triggers and policies that call them, and the Codex-named twins of the
-- provider-neutral routines (design docs/design/subscription-core-2026-10-07.md,
-- 5.3 "R. Retirement" and the 0713 note "Kept until retirement").
--
-- Run it in a drained maintenance window after the SuperGrok (0747) and
-- Claude (0748) cutovers: stop every API, control-worker and turn-worker,
-- pass the complete runtime-login list, apply, then start only a release
-- that contains this migration. Never roll it back: recovery is fix-forward.
--
-- It also finalizes the provider-keyed reach rows (0713 note "Kept until
-- retirement"): the reach table takes its provider-free name in place of
-- 0713's view, gains the key to its connection's provider and loses the
-- Codex default, and 0689's auto-assignment and plan-change triggers, their
-- functions, its two owner-only auto-assignment policies and their setting
-- take provider-free names. None of that could run while a rolling
-- migration had to keep the names and defaults older binaries used.
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

-- The kept objects that name one of the given objects, for the preflight's
-- refusal. A kept object can reach an object by name through a routine body
-- (PL/pgSQL, SQL string or SQL-standard), a policy expression, a trigger's
-- WHEN clause or arguments, a view query, a column default or generation
-- expression, or a CHECK constraint, and it can write the name literally or
-- build it at run time around its provider token: as a format() pattern
-- ('resolve_%s_authority_pool') or as the literals of a concatenation
-- ('resolve_' || provider || '_authority_pool'). Catalog dependencies are
-- checked separately through pg_depend. Session-local objects (this run's
-- own helpers and earlier migrations' staging) are not kept.
CREATE FUNCTION pg_temp.subscription_retirement_naming_objects(
  names text[], routines oid[], policies oid[], triggers oid[], relations oid[]
) RETURNS text LANGUAGE plpgsql STABLE AS $subscription_retirement_naming_objects$
DECLARE
  name_pattern text;
  tail_pattern text;
  -- A fragment may use an ordinary quote, an untagged/tagged dollar quote,
  -- or a format placeholder. Dollar tags follow identifier spelling rules.
  fragment_boundary text := '(''|\$([[:alpha:]_][[:alnum:]_]*)?\$|%[-0-9$*]*[sIL])';
  found text;
BEGIN
  IF coalesce(cardinality(names), 0) = 0 OR EXISTS (SELECT 1 FROM unnest(names) name
      WHERE name IS NULL OR name !~ '^[a-z0-9_]*(xai|claude|codex)[a-z0-9_]*$') THEN
    RAISE EXCEPTION '0751 received an invalid retired name' USING ERRCODE = '55000';
  END IF;
  -- One literal and one tail prefilter keep the per-name check to the rare
  -- object that has a tail.
  SELECT '\m(' || string_agg(DISTINCT name, '|') || ')\M',
    fragment_boundary || '(' || string_agg(DISTINCT parts[3], '|') || ')\M'
  INTO name_pattern, tail_pattern
  FROM unnest(names) name, regexp_match(name, '^(.*?)(xai|claude|codex)(.*)$') parts;
  SELECT string_agg(DISTINCT kept.object, ', ' ORDER BY kept.object) INTO found
  FROM (
    SELECT 'routine ' || routine.oid::regprocedure::text AS object,
      coalesce(routine.prosrc, '') || ' ' || coalesce(pg_get_function_sqlbody(routine.oid), '') AS body
    FROM pg_proc routine JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND namespace.nspname !~ '^pg_(toast_)?temp_' AND NOT (routine.oid = ANY(routines))
    UNION ALL
    SELECT 'policy ' || relation.relname || '.' || policy.polname,
      coalesce(pg_get_expr(policy.polqual, policy.polrelid), '') || ' '
        || coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid), '')
    FROM pg_policy policy JOIN pg_class relation ON relation.oid = policy.polrelid
    WHERE relation.relpersistence <> 't' AND NOT (policy.oid = ANY(policies))
    UNION ALL
    SELECT 'trigger ' || relation.relname || '.' || trigger_row.tgname,
      coalesce(substring(definition FROM ' WHEN (.*) EXECUTE FUNCTION '), '') || ' '
        || coalesce(substring(definition FROM ' EXECUTE FUNCTION [^(]*(\(.*\))$'), '')
    FROM pg_trigger trigger_row JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
    CROSS JOIN LATERAL pg_get_triggerdef(trigger_row.oid) definition
    WHERE NOT trigger_row.tgisinternal AND relation.relpersistence <> 't'
      AND NOT (trigger_row.oid = ANY(triggers))
    UNION ALL
    SELECT 'view ' || relation.oid::regclass::text, pg_get_viewdef(relation.oid)
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE relation.relkind IN ('v', 'm') AND relation.relpersistence <> 't'
      AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND NOT (relation.oid = ANY(relations))
    UNION ALL
    SELECT 'default ' || relation.oid::regclass::text || '.' || attribute.attname,
      pg_get_expr(attribute_default.adbin, attribute_default.adrelid)
    FROM pg_attrdef attribute_default
    JOIN pg_class relation ON relation.oid = attribute_default.adrelid
    JOIN pg_attribute attribute ON attribute.attrelid = attribute_default.adrelid
      AND attribute.attnum = attribute_default.adnum
    WHERE relation.relpersistence <> 't'
    UNION ALL
    SELECT 'constraint ' || constraint_row.conname, pg_get_constraintdef(constraint_row.oid)
    FROM pg_constraint constraint_row JOIN pg_namespace namespace ON namespace.oid = constraint_row.connamespace
    WHERE constraint_row.contype = 'c' AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND namespace.nspname !~ '^pg_(toast_)?temp_'
  ) kept
  -- Unquoted PostgreSQL identifiers fold to lowercase. A case-insensitive
  -- search also conservatively refuses quoted lookalikes rather than missing
  -- an executable uppercase call that has no pg_depend edge.
  WHERE kept.body ~* name_pattern
    OR (kept.body ~* tail_pattern AND EXISTS (
      SELECT 1 FROM unnest(names) name, regexp_match(name, '^(.*?)(xai|claude|codex)(.*)$') parts
      WHERE kept.body ~* (fragment_boundary || parts[3] || '\M')
        AND (parts[1] = '' OR kept.body ~* ('\m' || parts[1] || fragment_boundary))));
  RETURN found;
END $subscription_retirement_naming_objects$;

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
  -- Reach finalization (steps 10 and 11): each opengeni_private trigger
  -- function's Codex name and its provider-free name; each trigger's table,
  -- Codex name, provider-free name and function; each owner-only policy's
  -- table, Codex name and provider-free name.
  renamed_routines text[] := ARRAY[
    ['auto_assign_subscription_codex_workspace', 'auto_assign_subscription_core_workspace'],
    ['auto_assign_subscription_codex_personal_workspace',
      'auto_assign_subscription_core_personal_workspace'],
    ['record_subscription_codex_plan_change', 'record_subscription_core_plan_change']
  ];
  renamed_triggers text[] := ARRAY[
    ['workspaces', 'workspaces_subscription_codex_auto_assign',
      'workspaces_subscription_core_auto_assign', 'auto_assign_subscription_codex_workspace'],
    ['organization_memberships', 'organization_memberships_subscription_codex_auto_assign',
      'organization_memberships_subscription_core_auto_assign',
      'auto_assign_subscription_codex_personal_workspace'],
    ['subscription_connections', 'subscription_connections_codex_plan_change_trg',
      'subscription_connections_core_plan_change_trg', 'record_subscription_codex_plan_change']
  ];
  renamed_policies text[] := ARRAY[
    ['subscription_connection_workspaces', 'subscription_connection_workspaces_codex_auto_assign',
      'subscription_connection_workspaces_core_auto_assign'],
    ['subscription_connection_assignment_policies',
      'subscription_connection_assignment_policies_codex_auto_assign',
      'subscription_connection_assignment_policies_core_auto_assign']
  ];
  renamed text[];
  renamed_routine_ids oid[] := '{}';
  renamed_trigger_ids oid[] := '{}';
  renamed_policy_ids oid[] := '{}';
  reach_view oid := to_regclass('opengeni_private.subscription_core_auto_assignments');
  reach_table oid := to_regclass('opengeni_private.subscription_codex_auto_assignments');
  retired_routine_ids oid[];
  retired_policy_ids oid[];
  retired_trigger_ids oid[];
  retired_names text[];
  finding text;
BEGIN
  -- 1. Drained: no application session is connected to this database.
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0751 requires explicit application database roles' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR octet_length(item #>> '{}') NOT BETWEEN 1 AND 63
      OR item #>> '{}' <> btrim(item #>> '{}')
  ) THEN RAISE EXCEPTION '0751 received invalid application roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r.value = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0751 requires drained application sessions' USING ERRCODE = '55000';
  END IF;

  -- 2. Every provider is on the shared core: the Codex (0689), SuperGrok
  -- (0747) and Claude (0748) cutover receipts are committed. A fresh install
  -- has all three: 0689 seeds Codex's, and 0747 and 0748 write theirs on an
  -- empty database too.
  IF to_regprocedure('opengeni_private.subscription_provider_cutover_committed(text)') IS NULL THEN
    RAISE EXCEPTION '0751 requires the provider cutover receipts (0712)' USING ERRCODE = '55000';
  END IF;
  SELECT string_agg(provider, ', ' ORDER BY provider) INTO finding
  FROM unnest(ARRAY['codex', 'xai', 'claude']) provider
  WHERE NOT opengeni_private.subscription_provider_cutover_committed(provider);
  IF finding IS NOT NULL THEN
    RAISE EXCEPTION '0751 requires the committed cutover receipt of every provider; missing: %', finding
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
    RAISE EXCEPTION '0751 found a retired routine missing or changed: %; see the runbook', finding
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
    RAISE EXCEPTION '0751 found an unexpected overload of a retired routine: %; see the runbook', finding
      USING ERRCODE = '55000';
  END IF;
  SELECT string_agg(entry, ', ' ORDER BY entry) INTO finding
  FROM unnest(retired_policies) entry
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_policy policy JOIN pg_class relation ON relation.oid = policy.polrelid
    WHERE relation.relnamespace = data_schema::regnamespace
      AND relation.relname = split_part(entry, '.', 1) AND policy.polname = split_part(entry, '.', 2));
  IF finding IS NOT NULL THEN
    RAISE EXCEPTION '0751 found a retired policy missing: %; see the runbook', finding USING ERRCODE = '55000';
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
    RAISE EXCEPTION '0751 found a retired trigger missing or changed: %; see the runbook', finding
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
  -- pg_stat_activity records the original login, not a SET ROLE identity.
  -- Check every role it can SET (including transitive, NOINHERIT membership),
  -- even before it switches, and each such role's inherited privileges.
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN pg_roles login ON login.oid = activity.usesysid
    WHERE activity.datname = current_database() AND activity.pid <> pg_backend_pid()
      -- A non-superuser owner sees NULL for another role's backend_type.
      AND coalesce(activity.backend_type, 'client backend') = 'client backend'
      AND login.rolname <> current_user AND NOT login.rolsuper
      AND EXISTS (SELECT 1 FROM pg_roles usable
        WHERE (usable.oid = login.oid OR pg_has_role(login.oid, usable.oid, 'SET'))
        AND (EXISTS (SELECT 1 FROM pg_proc routine
          WHERE routine.oid = ANY(retired_routine_ids) AND routine.prorettype <> 'trigger'::regtype
            AND has_function_privilege(usable.oid, routine.oid, 'EXECUTE'))
        OR EXISTS (SELECT 1 FROM pg_class relation
          WHERE relation.relnamespace = data_schema::regnamespace
            AND relation.relname IN (
              SELECT split_part(entry, '.', 1) FROM unnest(retired_policies || retired_triggers) entry)
            AND (has_table_privilege(usable.oid, relation.oid, 'INSERT')
              OR has_table_privilege(usable.oid, relation.oid, 'UPDATE')
              OR has_table_privilege(usable.oid, relation.oid, 'DELETE')))))
  ) THEN
    RAISE EXCEPTION '0751 requires drained application sessions (a connected role outside the listed application roles can use a retired object)'
      USING ERRCODE = '55000';
  END IF;

  -- 5. Nothing that stays depends on a retired routine. Catalog dependencies
  -- (policies, triggers, views, defaults, constraints and SQL-standard
  -- bodies) are in pg_depend; every text a kept object could use to reach
  -- one by name (see pg_temp.subscription_retirement_naming_objects) is
  -- searched for the retired names, together with the retired policy and
  -- trigger names that dynamic SQL in a kept routine could use. This covers
  -- the scheduled-task authority routines that still read stored v1
  -- SuperGrok and Claude values (admit_scheduled_agent_run_execution,
  -- record_scheduled_task_revision_authority and their peers).
  SELECT string_agg(DISTINCT pg_describe_object(d.classid, d.objid, d.objsubid), ', ') INTO finding
  FROM pg_depend d
  WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = ANY(retired_routine_ids)
    AND NOT (d.classid = 'pg_proc'::regclass AND d.objid = ANY(retired_routine_ids))
    AND NOT (d.classid = 'pg_policy'::regclass AND d.objid = ANY(retired_policy_ids))
    AND NOT (d.classid = 'pg_trigger'::regclass AND d.objid = ANY(retired_trigger_ids));
  IF finding IS NOT NULL THEN
    RAISE EXCEPTION '0751 found a kept object that depends on a retired routine: %', finding
      USING ERRCODE = '2BP01';
  END IF;
  retired_names := retired_names
    || ARRAY(SELECT split_part(entry, '.', 2) FROM unnest(retired_policies) entry)
    || ARRAY(SELECT split_part(entry, '.', 2) FROM unnest(retired_triggers) entry);
  finding := pg_temp.subscription_retirement_naming_objects(
    retired_names, retired_routine_ids, retired_policy_ids, retired_trigger_ids, '{}');
  IF finding IS NOT NULL THEN
    RAISE EXCEPTION '0751 found a kept object that names a retired object: %', finding
      USING ERRCODE = '2BP01';
  END IF;

  -- 6. Reach finalization (steps 10 and 11): the reach table and 0713's view
  -- over it, the column's Codex default, the connections' (account,
  -- provider, id) key the new reference needs, the three trigger functions
  -- on their triggers and the two owner-only policies on the setting exist
  -- exactly as 0713 left them, their provider-free names are free, and
  -- nothing that stays names one of the Codex-named objects or the setting.
  IF (SELECT relation.relkind FROM pg_class relation WHERE relation.oid = reach_table)
      IS DISTINCT FROM 'r'
    OR (SELECT relation.relkind FROM pg_class relation WHERE relation.oid = reach_view)
      IS DISTINCT FROM 'v'
    OR EXISTS (SELECT 1 FROM pg_depend d WHERE d.refclassid = 'pg_class'::regclass
      AND d.refobjid = reach_view AND d.deptype <> 'i')
    OR (SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d
      JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE d.adrelid = reach_table AND a.attname = 'provider') IS DISTINCT FROM '''codex''::text'
    OR NOT EXISTS (SELECT 1 FROM pg_index i
      WHERE i.indrelid = to_regclass(format('%I.subscription_connections', data_schema))
        AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL
        AND i.indnatts = 3 AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey::int2[]) k
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k ORDER BY a.attname)
          = ARRAY['account_id', 'id', 'provider']) THEN
    RAISE EXCEPTION '0751 found the reach table, its view, its default or the connection key changed; see the runbook'
      USING ERRCODE = '55000';
  END IF;
  FOREACH renamed SLICE 1 IN ARRAY renamed_routines LOOP
    IF (SELECT routine.prorettype FROM pg_proc routine
        WHERE routine.oid = to_regprocedure(format('opengeni_private.%I()', renamed[1])))
        IS DISTINCT FROM 'trigger'::regtype
      OR EXISTS (SELECT 1 FROM pg_proc routine
        WHERE routine.pronamespace = 'opengeni_private'::regnamespace
          AND routine.proname IN (renamed[1], renamed[2])
          AND routine.oid <> to_regprocedure(format('opengeni_private.%I()', renamed[1]))) THEN
      RAISE EXCEPTION '0751 found a reach routine missing, changed or already renamed: %; see the runbook',
        renamed[1] USING ERRCODE = '55000';
    END IF;
    renamed_routine_ids := renamed_routine_ids
      || to_regprocedure(format('opengeni_private.%I()', renamed[1]))::oid;
  END LOOP;
  FOREACH renamed SLICE 1 IN ARRAY renamed_triggers LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger trigger_row
        JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
        WHERE relation.relnamespace = data_schema::regnamespace AND relation.relname = renamed[1]
          AND trigger_row.tgname = renamed[2] AND NOT trigger_row.tgisinternal
          AND trigger_row.tgfoid = to_regprocedure(format('opengeni_private.%I()', renamed[4])))
      OR EXISTS (SELECT 1 FROM pg_trigger trigger_row
        JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
        WHERE relation.relnamespace = data_schema::regnamespace AND relation.relname = renamed[1]
          AND trigger_row.tgname = renamed[3]) THEN
      RAISE EXCEPTION '0751 found a reach trigger missing, changed or already renamed: %.%; see the runbook',
        renamed[1], renamed[2] USING ERRCODE = '55000';
    END IF;
    renamed_trigger_ids := renamed_trigger_ids || (SELECT trigger_row.oid FROM pg_trigger trigger_row
      JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
      WHERE relation.relnamespace = data_schema::regnamespace AND relation.relname = renamed[1]
        AND trigger_row.tgname = renamed[2] AND NOT trigger_row.tgisinternal);
  END LOOP;
  FOREACH renamed SLICE 1 IN ARRAY renamed_policies LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policy policy
        JOIN pg_class relation ON relation.oid = policy.polrelid
        WHERE relation.relnamespace = data_schema::regnamespace AND relation.relname = renamed[1]
          AND policy.polname = renamed[2] AND policy.polcmd = '*' AND policy.polpermissive
          AND pg_get_expr(policy.polqual, policy.polrelid)
            ~ '\mopengeni\.subscription_codex_auto_assign\M'
          AND pg_get_expr(policy.polwithcheck, policy.polrelid)
            ~ '\mopengeni\.subscription_codex_auto_assign\M')
      OR EXISTS (SELECT 1 FROM pg_policy policy
        JOIN pg_class relation ON relation.oid = policy.polrelid
        WHERE relation.relnamespace = data_schema::regnamespace AND relation.relname = renamed[1]
          AND policy.polname = renamed[3]) THEN
      RAISE EXCEPTION '0751 found a reach policy missing, changed or already renamed: %.%; see the runbook',
        renamed[1], renamed[2] USING ERRCODE = '55000';
    END IF;
    renamed_policy_ids := renamed_policy_ids || (SELECT policy.oid FROM pg_policy policy
      JOIN pg_class relation ON relation.oid = policy.polrelid
      WHERE relation.relnamespace = data_schema::regnamespace AND relation.relname = renamed[1]
        AND policy.polname = renamed[2]);
  END LOOP;
  -- The two trigger functions and two policies that use the setting are
  -- redefined in step 11, their triggers follow the renamed functions and
  -- step 10 drops 0713's view; nothing else may name a Codex-named reach
  -- object (the table, the setting or a renamed routine, trigger or policy).
  finding := pg_temp.subscription_retirement_naming_objects(
    ARRAY['subscription_codex_auto_assignments', 'subscription_codex_auto_assign']
      || ARRAY(SELECT unnest(renamed_routines[1:3][1:1]))
      || ARRAY(SELECT unnest(renamed_triggers[1:3][2:2]))
      || ARRAY(SELECT unnest(renamed_policies[1:2][2:2])),
    retired_routine_ids || renamed_routine_ids, retired_policy_ids || renamed_policy_ids,
    retired_trigger_ids || renamed_trigger_ids, ARRAY[reach_view]);
  IF finding IS NOT NULL THEN
    RAISE EXCEPTION '0751 found a kept object that names a Codex-named reach object: %', finding
      USING ERRCODE = '2BP01';
  END IF;
END
$retirement_preflight$;

DROP FUNCTION pg_temp.subscription_retirement_naming_objects(text[], oid[], oid[], oid[], oid[]);

-- 7. The policies that call the retired routines or read the retired
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

-- 8. The triggers that call the retired trigger functions (the 0234 and 0598
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

-- 9. The routines. The SuperGrok and Claude pool routines (writers,
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

-- 10. Reach finalization (0713 note "Kept until retirement"). 0713's view
-- goes and the reach table takes its provider-free name, so the neutral
-- routines, which name the view, need no change. Every row gains the key to
-- its connection's provider (the connections' (account, provider, id) key
-- exists since 0712) and the column loses the Codex default only an older
-- binary's reach write needed. A row whose provider is not its connection's
-- refuses the migration without naming it.
DROP VIEW opengeni_private.subscription_core_auto_assignments;
ALTER TABLE opengeni_private.subscription_codex_auto_assignments
  RENAME TO subscription_core_auto_assignments;
COMMENT ON TABLE opengeni_private.subscription_core_auto_assignments IS
  'Owner-only reach of an organization connection over workspaces created later, keyed by the connection and its provider. Runtime roles never read or write it.';
ALTER TABLE opengeni_private.subscription_core_auto_assignments
  ADD CONSTRAINT subscription_core_auto_assignments_connection_provider_fkey
    FOREIGN KEY (account_id, provider, connection_id)
    REFERENCES subscription_connections (account_id, provider, id) ON DELETE CASCADE NOT VALID;
DO $reach_key$
BEGIN
  -- The migration owner is NOSUPERUSER/NOBYPASSRLS with no tenant context.
  -- PostgreSQL's FK validation can fall back to row checks when FORCE RLS
  -- hides the referenced rows. Open only the owner's visibility window;
  -- runtime roles remain policy-bound, and rollback restores FORCE on error.
  ALTER TABLE subscription_connections NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE opengeni_private.subscription_core_auto_assignments
    VALIDATE CONSTRAINT subscription_core_auto_assignments_connection_provider_fkey;
  ALTER TABLE subscription_connections FORCE ROW LEVEL SECURITY;
EXCEPTION WHEN foreign_key_violation THEN
  RAISE EXCEPTION '0751 found a reach row whose provider is not its connection''s; see the runbook'
    USING ERRCODE = '23503';
END
$reach_key$;
ALTER TABLE opengeni_private.subscription_core_auto_assignments
  ALTER COLUMN provider DROP DEFAULT;

-- 11. Provider-free names for 0689's auto-assignment and plan-change
-- triggers and their functions (owner, security mode and search path stay;
-- "core" sorts where "codex" did among each table's triggers, so the firing
-- order is unchanged), and for its two owner-only auto-assignment policies
-- and their setting, which the two auto-assignment functions set to the
-- organization around each provider's apply and then restore. The three
-- functions end owner-only (below), whatever was granted on their Codex names.
ALTER TRIGGER workspaces_subscription_codex_auto_assign ON workspaces
  RENAME TO workspaces_subscription_core_auto_assign;
ALTER TRIGGER organization_memberships_subscription_codex_auto_assign ON organization_memberships
  RENAME TO organization_memberships_subscription_core_auto_assign;
ALTER TRIGGER subscription_connections_codex_plan_change_trg ON subscription_connections
  RENAME TO subscription_connections_core_plan_change_trg;
ALTER FUNCTION opengeni_private.auto_assign_subscription_codex_workspace()
  RENAME TO auto_assign_subscription_core_workspace;
ALTER FUNCTION opengeni_private.auto_assign_subscription_codex_personal_workspace()
  RENAME TO auto_assign_subscription_core_personal_workspace;
ALTER FUNCTION opengeni_private.record_subscription_codex_plan_change()
  RENAME TO record_subscription_core_plan_change;
ALTER POLICY subscription_connection_workspaces_codex_auto_assign
  ON subscription_connection_workspaces
  RENAME TO subscription_connection_workspaces_core_auto_assign;
ALTER POLICY subscription_connection_assignment_policies_codex_auto_assign
  ON subscription_connection_assignment_policies
  RENAME TO subscription_connection_assignment_policies_core_auto_assign;
DO $reach_setting$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    ALTER POLICY subscription_connection_workspaces_core_auto_assign
    ON %1$I.subscription_connection_workspaces
    USING (CURRENT_USER = pg_catalog.pg_get_userbyid((SELECT relation.relowner
        FROM pg_catalog.pg_class relation
        WHERE relation.oid = '%1$I.subscription_connection_workspaces'::regclass))
      AND current_setting('opengeni.subscription_core_auto_assign', true) = account_id::text)
    WITH CHECK (CURRENT_USER = pg_catalog.pg_get_userbyid((SELECT relation.relowner
        FROM pg_catalog.pg_class relation
        WHERE relation.oid = '%1$I.subscription_connection_workspaces'::regclass))
      AND current_setting('opengeni.subscription_core_auto_assign', true) = account_id::text)
  $ddl$, data_schema);
  EXECUTE format($ddl$
    ALTER POLICY subscription_connection_assignment_policies_core_auto_assign
    ON %1$I.subscription_connection_assignment_policies
    USING (CURRENT_USER = pg_catalog.pg_get_userbyid((SELECT relation.relowner
        FROM pg_catalog.pg_class relation
        WHERE relation.oid = '%1$I.subscription_connection_assignment_policies'::regclass))
      AND current_setting('opengeni.subscription_core_auto_assign', true) = account_id::text)
    WITH CHECK (CURRENT_USER = pg_catalog.pg_get_userbyid((SELECT relation.relowner
        FROM pg_catalog.pg_class relation
        WHERE relation.oid = '%1$I.subscription_connection_assignment_policies'::regclass))
      AND current_setting('opengeni.subscription_core_auto_assign', true) = account_id::text)
  $ddl$, data_schema);
  -- 0713's bodies under the provider-free setting.
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.auto_assign_subscription_core_workspace()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      reach_provider text;
      previous text := current_setting('opengeni.subscription_core_auto_assign', true);
    BEGIN
      FOR reach_provider IN SELECT DISTINCT auto.provider
          FROM opengeni_private.subscription_core_auto_assignments auto
          WHERE auto.account_id = NEW.account_id ORDER BY auto.provider LOOP
        PERFORM pg_catalog.set_config('opengeni.subscription_core_auto_assign',
          NEW.account_id::text, true);
        PERFORM opengeni_subscription_internal.apply_subscription_core_auto_assignments(
          reach_provider, NEW.account_id, NEW.id, false);
        PERFORM pg_catalog.set_config('opengeni.subscription_core_auto_assign',
          coalesce(previous, ''), true);
      END LOOP;
      RETURN NEW;
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.auto_assign_subscription_core_personal_workspace()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      reach_provider text;
      previous text := current_setting('opengeni.subscription_core_auto_assign', true);
    BEGIN
      IF NEW.personal_workspace_id IS NOT NULL AND (TG_OP = 'INSERT'
          OR NEW.personal_workspace_id IS DISTINCT FROM OLD.personal_workspace_id) THEN
        FOR reach_provider IN SELECT DISTINCT auto.provider
            FROM opengeni_private.subscription_core_auto_assignments auto
            WHERE auto.account_id = NEW.account_id ORDER BY auto.provider LOOP
          PERFORM pg_catalog.set_config('opengeni.subscription_core_auto_assign',
            NEW.account_id::text, true);
          PERFORM opengeni_subscription_internal.apply_subscription_core_auto_assignments(
            reach_provider, NEW.account_id, NEW.personal_workspace_id, true);
          PERFORM pg_catalog.set_config('opengeni.subscription_core_auto_assign',
            coalesce(previous, ''), true);
        END LOOP;
      END IF;
      RETURN NEW;
    END
    $body$
  $ddl$, data_schema);
END
$reach_setting$;
-- provision-roles grants EXECUTE on every opengeni_private function and then
-- revokes the owner-only ones by name; it names these three by their
-- provider-free names, which exist only from here on. Triggers fire without
-- the caller holding EXECUTE, so no grantee keeps one: PUBLIC and every
-- other grantee lose EXECUTE, in name order.
DO $owner_only_trigger_functions$
DECLARE
  routine_name text;
  grantee_name text;
BEGIN
  FOREACH routine_name IN ARRAY ARRAY[
    'auto_assign_subscription_core_personal_workspace',
    'auto_assign_subscription_core_workspace',
    'record_subscription_core_plan_change'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.%I() FROM PUBLIC', routine_name);
    FOR grantee_name IN
      SELECT DISTINCT pg_catalog.pg_get_userbyid(acl.grantee)
      FROM pg_catalog.pg_proc proc, pg_catalog.aclexplode(proc.proacl) acl
      WHERE proc.oid = format('opengeni_private.%I()', routine_name)::regprocedure
        AND acl.grantee <> 0 AND acl.grantee <> proc.proowner
      ORDER BY 1
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.%I() FROM %I',
        routine_name, grantee_name);
    END LOOP;
  END LOOP;
END
$owner_only_trigger_functions$;
