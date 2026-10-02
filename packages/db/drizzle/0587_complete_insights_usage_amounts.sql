-- deployment-mode: rolling
-- Amounts include every ledger/fact row. Raw visible-detail functions are not
-- changed. The owner-only inventory capability is confined to these definers;
-- hidden session identity, content, root/schedule links and contributions never
-- leave the database. No policies, charges, debits or historical rows change.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $amounts$
DECLARE
  data_schema text := current_schema();
  definition text;
  original text;
BEGIN
  -- Retain the reviewed 0359 window/context/capability protocol verbatim while
  -- creating an amount-only sibling, not widening the released visible reader.
  SELECT pg_get_functiondef('opengeni_private.visible_workspace_insights_usage_projection(uuid,timestamptz,timestamptz,text[])'::regprocedure)
  INTO original;
  definition := replace(original, 'visible_workspace_insights_usage_projection', 'complete_workspace_insights_usage_projection');
  definition := regexp_replace(definition,
    $pattern$[[:space:]]+AND \([[:space:]]+usage_row.session_id IS NULL.*?\);$pattern$, ';');
  definition := replace(definition, 'usage_row.occurred_at, usage_row.source_resource_id',
    format('usage_row.occurred_at, CASE WHEN usage_row.session_id IS NULL
          OR (session_row.id IS NOT NULL AND (context_subject_id IS NULL
            OR session_row.visibility = ''workspace_shared''
            OR %I.session_private_actor_visible(session_row.account_id, session_row.workspace_id,
              session_row.owner_organization_membership_id, session_row.owner_subject_id)))
          THEN usage_row.source_resource_id END', data_schema));
  IF definition = original
    OR definition ~ 'AND \([[:space:]]+usage_row.session_id IS NULL'
    OR position('CASE WHEN usage_row.session_id IS NULL' IN definition) = 0 THEN
    RAISE EXCEPTION 'Complete usage projection source contract changed';
  END IF;
  EXECUTE definition;
  REVOKE ALL ON FUNCTION opengeni_private.complete_workspace_insights_usage_projection(uuid,timestamptz,timestamptz,text[]) FROM PUBLIC;

  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.workspace_insights_amount_fact_rows(
      p_workspace_id uuid, p_since timestamptz, p_until timestamptz,
      p_provider text, p_model text, p_root_session_id uuid, p_session_id uuid
    ) RETURNS TABLE (
      id uuid, session_id uuid, root_session_id uuid, turn_id uuid,
      provider text, provider_api text, model text, billing_path text,
      scheduled_task_id uuid, input_tokens bigint, output_tokens bigint,
      cached_tokens bigint, cache_write_tokens bigint, reasoning_tokens bigint,
      total_tokens bigint, priced_cost_micros bigint,
      estimated_provider_cost_micros bigint, equivalent_credit_cost_micros bigint,
      pricing_source text, context_contributions jsonb, occurred_at timestamptz,
      recorded_at timestamptz, private_owner_key text, private_name text
    ) LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    SET enable_nestloop = off
    AS $fn$
    DECLARE
      account_value uuid;
      workspace_value uuid;
      subject_value text := nullif(current_setting('opengeni.subject_id', true), '');
      human_value text := nullif(current_setting('opengeni.initiating_human_subject_id', true), '');
      inventory uuid;
      previous_lifecycle text;
    BEGIN
      PERFORM opengeni_private.session_variable_set_attachments_protocol_v1_active();
      BEGIN
        account_value := nullif(current_setting('opengeni.account_id', true), '')::uuid;
        workspace_value := nullif(current_setting('opengeni.workspace_id', true), '')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'Insights amount context is malformed' USING ERRCODE = '42501';
      END;
      IF account_value IS NULL OR workspace_value IS DISTINCT FROM p_workspace_id
        OR p_workspace_id IS NULL THEN
        RAISE EXCEPTION 'Insights amount context does not match workspace' USING ERRCODE = '42501';
      END IF;
      IF p_since IS NULL OR p_until IS NULL OR NOT isfinite(p_since)
        OR NOT isfinite(p_until) OR p_until < p_since OR p_until - p_since > interval '370 days'
        OR (p_provider IS NOT NULL AND (btrim(p_provider) = '' OR octet_length(p_provider) > 256))
        OR (p_model IS NOT NULL AND (btrim(p_model) = '' OR octet_length(p_model) > 512)) THEN
        RAISE EXCEPTION 'Insights amount window or filters are invalid' USING ERRCODE = '22023';
      END IF;
      IF p_root_session_id IS NOT NULL OR p_session_id IS NOT NULL THEN
        -- No private amounts in a drilldown. Keep its exact existing visibility.
        RETURN QUERY SELECT visible.*, null::text, null::text
          FROM opengeni_private.visible_workspace_insights_model_fact_rows(
            p_workspace_id, p_since, p_until, p_provider, p_model, p_root_session_id, p_session_id
          ) visible;
        RETURN;
      END IF;
      inventory := opengeni_private.open_session_tenancy_fence_inventory(%2$s::oid);
      previous_lifecycle := current_setting('opengeni.organization_tenancy_lifecycle', true);
      PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true);
      INSERT INTO opengeni_private.insights_fact_read_runtime_capabilities
        (backend_pid, transaction_id, capability_kind, account_id, workspace_id, subject_id, initiating_human_subject_id)
      VALUES (pg_backend_pid(), pg_current_xact_id(), 'model_call_facts', account_value, p_workspace_id, subject_value, human_value);
      BEGIN
        RETURN QUERY
          WITH inventory_sessions AS MATERIALIZED (
            SELECT session_row.id, session_row.root_session_id,
              session_row.owner_subject_id, session_row.owner_organization_membership_id,
              (subject_value IS NULL OR session_row.visibility = 'workspace_shared'
                OR %1$I.session_private_actor_visible(session_row.account_id, session_row.workspace_id,
                  session_row.owner_organization_membership_id, session_row.owner_subject_id)) AS visible
            FROM %1$I.sessions session_row
            WHERE session_row.account_id = account_value AND session_row.workspace_id = p_workspace_id
          )
          SELECT
            CASE WHEN session_row.visible THEN fact.id END,
            CASE WHEN session_row.visible THEN fact.session_id END,
            CASE WHEN session_row.visible THEN session_row.root_session_id END,
            CASE WHEN session_row.visible THEN fact.turn_id END,
            fact.provider, fact.provider_api, fact.model, fact.billing_path,
            CASE WHEN session_row.visible THEN fact.scheduled_task_id END,
            fact.input_tokens, fact.output_tokens, fact.cached_tokens, fact.cache_write_tokens,
            fact.reasoning_tokens, fact.total_tokens, fact.priced_cost_micros,
            fact.estimated_provider_cost_micros, fact.equivalent_credit_cost_micros,
            fact.pricing_source, CASE WHEN session_row.visible THEN fact.context_contributions END,
            fact.occurred_at, fact.recorded_at,
            CASE WHEN NOT session_row.visible AND coalesce(session_row.owner_subject_id,
                session_row.owner_organization_membership_id::text) IS NOT NULL
              THEN encode(sha256(convert_to(account_value::text || ':' || coalesce(
                session_row.owner_subject_id, session_row.owner_organization_membership_id::text), 'UTF8')), 'hex') END,
            CASE WHEN NOT session_row.visible THEN coalesce(auth_user.name, access.subject_label) END
          FROM %1$I.model_call_facts fact
          LEFT JOIN inventory_sessions session_row ON session_row.id = fact.session_id
          LEFT JOIN %1$I.workspace_memberships access ON access.account_id = account_value
            AND access.workspace_id = p_workspace_id AND access.subject_id = session_row.owner_subject_id
          LEFT JOIN %1$I.auth_users auth_user ON access.subject_id = 'user:' || auth_user.id
          WHERE fact.account_id = account_value AND fact.workspace_id = p_workspace_id
            AND fact.occurred_at >= p_since AND fact.occurred_at < p_until
            AND (p_provider IS NULL OR fact.provider = p_provider)
            AND (p_model IS NULL OR fact.model = p_model);
        DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities
          WHERE backend_pid = pg_backend_pid() AND transaction_id = pg_current_xact_id_if_assigned()
            AND capability_kind = 'model_call_facts';
        PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory);
        PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true);
      EXCEPTION WHEN OTHERS THEN
        DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities
          WHERE backend_pid = pg_backend_pid() AND transaction_id = pg_current_xact_id_if_assigned()
            AND capability_kind = 'model_call_facts';
        PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory);
        PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true);
        RAISE;
      END;
    END
    $fn$;
    REVOKE ALL ON FUNCTION opengeni_private.workspace_insights_amount_fact_rows(uuid,timestamptz,timestamptz,text,text,uuid,uuid) FROM PUBLIC;
  $ddl$, data_schema, (SELECT oid FROM pg_namespace WHERE nspname = data_schema));
END
$amounts$;

-- Replace aggregate function bodies with exact anchored changes. This keeps the
-- released signatures and grants, validation, inventory paging and bigint JSON
-- representation. Refuse drift rather than silently changing a different seam.
DO $organization_totals$
DECLARE definition text; original text;
BEGIN
  SELECT pg_get_functiondef('opengeni_private.organization_usage_summary(uuid,timestamptz,timestamptz,text,uuid,boolean)'::regprocedure) INTO original;
  definition := replace(original, 'previous_lifecycle text;', 'previous_lifecycle text; inventory uuid;');
  -- Main ledger totals never depend on a session join. Retained missing rows
  -- remain charges even when no owner can be safely attributed.
  definition := replace(definition, 'AND (usage_row.session_id IS NULL OR session_row.id IS NOT NULL)', '');
  definition := replace(definition, 'INSERT INTO opengeni_private.organization_usage_read_capabilities',
    'inventory := opengeni_private.open_session_tenancy_fence_inventory(session_tenancy_fence_target_schema());
      INSERT INTO opengeni_private.organization_usage_read_capabilities');
  definition := replace(definition, 'RETURN response;',
    'PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory);
        RETURN response;');
  definition := replace(definition, 'RAISE;' || chr(10) || '      END;',
    'PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory);
        RAISE;' || chr(10) || '      END;');
  IF definition = original OR position('session_row.id IS NOT NULL' IN definition) > 0 THEN
    RAISE EXCEPTION 'Organization ledger source contract changed';
  END IF;
  EXECUTE definition;

  SELECT pg_get_functiondef('opengeni_private.organization_model_usage_summary(uuid,timestamptz,timestamptz,uuid)'::regprocedure) INTO original;
  -- Facts already have an exact workspace, owner capability and actor scope;
  -- the visibility join serves no purpose in an amount-only aggregate.
  definition := regexp_replace(original,
    'INNER JOIN visible_sessions session_row[[:space:]]+ON session_row.account_id = fact.account_id[[:space:]]+AND session_row.workspace_id = fact.workspace_id[[:space:]]+AND session_row.id = fact.session_id', '');
  -- Payer grouping uses every per-provider/model/billing-path fact aggregate,
  -- before models are capped. Never infer the split from the top models.
  definition := replace(definition, $old$), grouped AS (
        SELECT$old$, $new$), payer_grouped AS (
        SELECT CASE WHEN billing_path = 'opengeni_credits' THEN 'opengeni_credits'
          WHEN provider IN ('codex-subscription', 'supergrok-subscription') THEN 'subscription'
          ELSE 'own_key' END AS payer,
          jsonb_build_object(
            'calls', sum(calls)::text, 'inputTokens', sum(input_tokens)::text,
            'outputTokens', sum(output_tokens)::text, 'cachedTokens', sum(cached_tokens)::text,
            'cacheInputTokens', sum(cache_input_tokens)::text, 'cacheWriteTokens', sum(cache_write_tokens)::text,
            'totalTokens', sum(total_tokens)::text, 'tokenKnownCalls', sum(token_known_calls)::text,
            'cacheKnownCalls', sum(cache_known_calls)::text, 'creditMicros', sum(credit_micros)::text,
            'estimatedProviderMicros', sum(estimated_provider_micros)::text,
            'estimatedProviderKnownCalls', sum(estimated_provider_known_calls)::text
          ) AS totals
        FROM fact GROUP BY 1
      ), grouped AS (
        SELECT$new$);
  definition := replace(definition, 'SELECT pg_catalog.jsonb_build_object(' || chr(10) || '        ''billing'',',
    'SELECT pg_catalog.jsonb_build_object(' || chr(10) ||
    '        ''payers'', coalesce((SELECT jsonb_agg(totals || jsonb_build_object(''payer'', payer) ORDER BY payer) FROM payer_grouped), ''[]''::jsonb),' || chr(10) || '        ''billing'',');
  IF definition = original OR position('INNER JOIN visible_sessions session_row' IN definition) > 0
    OR position('payer_grouped AS' IN definition) = 0 OR position('''payers''' IN definition) = 0 THEN
    RAISE EXCEPTION 'Organization model source contract changed';
  END IF;
  EXECUTE definition;
END
$organization_totals$;

DO $private_chat_amounts$
DECLARE data_schema text := current_schema(); definition text;
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.organization_private_chat_usage(
      p_account_id uuid, p_since timestamptz, p_until timestamptz
    ) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    SET enable_nestloop = off
    AS $fn$
    DECLARE
      subject_value text := nullif(current_setting('opengeni.subject_id', true), '');
      human_value text := nullif(current_setting('opengeni.initiating_human_subject_id', true), '');
      inventory uuid;
      previous_lifecycle text;
      shared_ids uuid[];
      response jsonb;
    BEGIN
      IF nullif(current_setting('opengeni.account_id', true), '') IS DISTINCT FROM p_account_id::text
        OR nullif(current_setting('opengeni.workspace_id', true), '') IS NOT NULL THEN
        RAISE EXCEPTION 'Private chat amounts require exact account-only context' USING ERRCODE = '42501';
      END IF;
      IF p_since IS NULL OR p_until IS NULL OR NOT isfinite(p_since) OR NOT isfinite(p_until)
        OR p_until < p_since OR p_until - p_since > interval '366 days' THEN
        RAISE EXCEPTION 'Private chat amount window is invalid' USING ERRCODE = '22023';
      END IF;
      PERFORM opengeni_private.session_variable_set_attachments_protocol_v1_active();
      SELECT coalesce(array_agg(workspace_id), '{}'::uuid[]) INTO shared_ids
        FROM %1$I.list_organization_workspace_ids(p_account_id);
      inventory := opengeni_private.open_session_tenancy_fence_inventory(%2$s::oid);
      previous_lifecycle := current_setting('opengeni.organization_tenancy_lifecycle', true);
      PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true);
      INSERT INTO opengeni_private.organization_usage_read_capabilities
        (backend_pid, transaction_id, account_id, subject_id, initiating_human_subject_id)
      VALUES (pg_backend_pid(), pg_current_xact_id(), p_account_id, subject_value, human_value);
      BEGIN
        WITH private_sessions AS MATERIALIZED (
          SELECT session_row.id, session_row.workspace_id, session_row.owner_subject_id,
            session_row.owner_organization_membership_id
          FROM %1$I.sessions session_row
          WHERE session_row.account_id = p_account_id AND session_row.workspace_id = ANY(shared_ids)
            AND subject_value IS NOT NULL AND session_row.visibility = 'user_private'
            AND NOT %1$I.session_private_actor_visible(session_row.account_id, session_row.workspace_id,
              session_row.owner_organization_membership_id, session_row.owner_subject_id)
        ), owner_totals AS (
          SELECT session_row.workspace_id, session_row.owner_subject_id,
            session_row.owner_organization_membership_id AS membership_id,
            usage_row.event_type, usage_row.unit, sum(usage_row.quantity) AS quantity,
            count(*) AS event_count
          FROM %1$I.usage_events usage_row
          JOIN private_sessions session_row ON session_row.id = usage_row.session_id
            AND session_row.workspace_id = usage_row.workspace_id
          WHERE usage_row.account_id = p_account_id
            AND usage_row.occurred_at >= p_since AND usage_row.occurred_at < p_until
          GROUP BY session_row.workspace_id, session_row.owner_subject_id,
            session_row.owner_organization_membership_id, usage_row.event_type, usage_row.unit
        ), owners AS MATERIALIZED (
          SELECT owner_row.workspace_id, owner_row.owner_subject_id, owner_row.membership_id,
            coalesce(auth_user.name, access.subject_label) AS name,
            jsonb_agg(jsonb_build_object('eventType', event_type, 'unit', unit,
              'quantity', quantity::text, 'eventCount', event_count::text) ORDER BY event_type, unit) AS totals,
            coalesce(sum(quantity) FILTER (WHERE event_type = 'model.cost' AND unit = 'usd_micros'), 0) AS spend
          FROM owner_totals owner_row
          LEFT JOIN %1$I.workspace_memberships access ON access.account_id = p_account_id
            AND access.workspace_id = owner_row.workspace_id AND access.subject_id = owner_row.owner_subject_id
          LEFT JOIN %1$I.auth_users auth_user ON access.subject_id = 'user:' || auth_user.id
          GROUP BY owner_row.workspace_id, owner_row.owner_subject_id, owner_row.membership_id,
            auth_user.name, access.subject_label
        )
        SELECT jsonb_build_object(
          'privateChats', coalesce((SELECT jsonb_agg(jsonb_build_object(
            'workspaceId', workspace_id, 'membershipId', membership_id, 'name', name, 'totals', totals
          ) ORDER BY spend DESC, workspace_id, membership_id, owner_subject_id)
          FROM (SELECT * FROM owners ORDER BY spend DESC, workspace_id, membership_id, owner_subject_id LIMIT 200) listed), '[]'::jsonb),
          'privateChatsTruncated', (SELECT count(*) > 200 FROM owners)
        ) INTO response;
        DELETE FROM opengeni_private.organization_usage_read_capabilities
          WHERE backend_pid = pg_backend_pid() AND transaction_id = pg_current_xact_id_if_assigned();
        PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory);
        PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true);
        RETURN response;
      EXCEPTION WHEN OTHERS THEN
        DELETE FROM opengeni_private.organization_usage_read_capabilities
          WHERE backend_pid = pg_backend_pid() AND transaction_id = pg_current_xact_id_if_assigned();
        PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory);
        PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true);
        RAISE;
      END;
    END
    $fn$;
    REVOKE ALL ON FUNCTION opengeni_private.organization_private_chat_usage(uuid,timestamptz,timestamptz) FROM PUBLIC;
  $ddl$, data_schema, (SELECT oid FROM pg_namespace WHERE nspname = data_schema));
  SELECT pg_get_functiondef('opengeni_private.organization_usage_summary(uuid,timestamptz,timestamptz,text,uuid,boolean)'::regprocedure) INTO definition;
  definition := replace(definition, 'RETURN response;',
    'IF p_include_period THEN
          response := response || opengeni_private.organization_private_chat_usage(p_account_id, p_since, p_until);
        END IF;
        RETURN response;');
  EXECUTE definition;
END
$private_chat_amounts$;

DO $acl$
DECLARE role_name text; target regprocedure;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'opengeni_private.complete_workspace_insights_usage_projection(uuid,timestamptz,timestamptz,text[])'::regprocedure,
    'opengeni_private.workspace_insights_amount_fact_rows(uuid,timestamptz,timestamptz,text,text,uuid,uuid)'::regprocedure
  ] LOOP
    FOR role_name IN SELECT DISTINCT role_row.rolname FROM pg_proc procedure
      CROSS JOIN LATERAL aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) privilege
      JOIN pg_roles role_row ON role_row.oid = privilege.grantee
      WHERE procedure.oid = target AND privilege.grantee <> procedure.proowner
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', target, role_name);
    END LOOP;
    FOR role_name IN SELECT role_row.rolname
      FROM jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) configured(value)
      JOIN pg_roles role_row ON role_row.rolname = configured.value
      WHERE has_table_privilege(role_row.rolname, format('%I.model_call_facts', current_schema()), 'SELECT')
        AND has_table_privilege(role_row.rolname, format('%I.usage_events', current_schema()), 'SELECT')
    LOOP
      EXECUTE format('GRANT USAGE ON SCHEMA opengeni_private TO %I', role_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', target, role_name);
    END LOOP;
  END LOOP;
END
$acl$;

RESET statement_timeout;
RESET lock_timeout;