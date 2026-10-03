-- deployment-mode: rolling
-- Organization Insights needs the per-call model facts (tokens, cache, credit-paid
-- versus externally billed, provider-rate estimates) that the 0473 ledger summary
-- cannot provide. This additive aggregate reads model_call_facts only through the
-- existing audited paths: for each workspace in the caller's organization it binds
-- the exact workspace context and mints the 0359 'model_call_facts' read capability,
-- applies the 0473 actor-visible session rule, and removes the capability before the
-- next workspace. No policy, table, or released function changes. It returns only
-- aggregates, never raw facts, and names only shared workspaces: Personal workspaces
-- appear as one explicit aggregate so the inventory reconciles to the totals.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $organization_model_usage$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format($ddl$
    CREATE FUNCTION opengeni_private.organization_model_usage_summary(
      p_account_id uuid,
      p_since timestamp with time zone,
      p_until timestamp with time zone,
      p_after_workspace_id uuid
    ) RETURNS jsonb
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    SET enable_nestloop = off
    SET plan_cache_mode = force_custom_plan
    AS $function$
    DECLARE
      context_account_id uuid;
      context_subject_id text;
      context_human_id text;
      shared_ids uuid[];
      page_ids uuid[];
      next_cursor uuid;
      workspace_row record;
      fact_rows jsonb := '[]'::jsonb;
      response jsonb;
    BEGIN
      PERFORM opengeni_private.session_variable_set_attachments_protocol_v1_active();
      BEGIN
        context_account_id := nullif(pg_catalog.current_setting('opengeni.account_id', true), '')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'Organization model usage account context is malformed' USING ERRCODE = '42501';
      END;
      context_subject_id := nullif(pg_catalog.current_setting('opengeni.subject_id', true), '');
      context_human_id := nullif(pg_catalog.current_setting('opengeni.initiating_human_subject_id', true), '');
      IF context_account_id IS NULL OR context_account_id IS DISTINCT FROM p_account_id
        OR nullif(pg_catalog.current_setting('opengeni.workspace_id', true), '') IS NOT NULL
      THEN
        RAISE EXCEPTION 'Organization model usage requires the exact account-only context'
          USING ERRCODE = '42501';
      END IF;
      IF p_since IS NULL OR p_until IS NULL OR NOT pg_catalog.isfinite(p_since)
        OR NOT pg_catalog.isfinite(p_until) OR p_until < p_since
        OR p_until - p_since > interval '366 days'
      THEN
        RAISE EXCEPTION 'Organization model usage window is invalid' USING ERRCODE = '22023';
      END IF;

      -- The same canonical shared-workspace inventory as the 0473 summary: every
      -- Personal workspace is excluded before paging.
      SELECT coalesce(pg_catalog.array_agg(listed.workspace_id ORDER BY listed.workspace_id), '{}'::uuid[])
      INTO shared_ids
      FROM %1$I.list_organization_workspace_ids(context_account_id) listed;
      SELECT coalesce(pg_catalog.array_agg(id ORDER BY id), '{}'::uuid[]) INTO page_ids
      FROM (
        SELECT id FROM %1$I.workspaces
        WHERE account_id = context_account_id
          AND id = ANY(shared_ids)
          AND (p_after_workspace_id IS NULL OR id > p_after_workspace_id)
        ORDER BY id
        LIMIT 51
      ) page;
      IF pg_catalog.cardinality(page_ids) > 50 THEN
        next_cursor := page_ids[50];
        page_ids := page_ids[1:50];
      END IF;

      BEGIN
        FOR workspace_row IN
          SELECT id FROM %1$I.workspaces WHERE account_id = context_account_id ORDER BY id
        LOOP
          -- Bind the exact workspace so the unchanged workspace RLS and the 0359
          -- capability each admit only this workspace's facts.
          PERFORM pg_catalog.set_config('opengeni.workspace_id', workspace_row.id::text, true);
          INSERT INTO opengeni_private.insights_fact_read_runtime_capabilities (
            backend_pid, transaction_id, capability_kind, account_id, workspace_id,
            subject_id, initiating_human_subject_id
          ) VALUES (
            pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'model_call_facts',
            context_account_id, workspace_row.id, context_subject_id, context_human_id
          );
          fact_rows := fact_rows || coalesce((
            WITH visible_sessions AS MATERIALIZED (
              SELECT id, account_id, workspace_id
              FROM %1$I.sessions session_row
              WHERE account_id = context_account_id
                AND workspace_id = workspace_row.id
                AND (context_subject_id IS NULL OR visibility = 'workspace_shared'
                  OR %1$I.session_private_actor_visible(account_id, workspace_id,
                    owner_organization_membership_id, owner_subject_id))
            ), grouped AS (
              SELECT fact.provider, fact.model, fact.billing_path,
                pg_catalog.count(*) AS calls,
                coalesce(pg_catalog.sum(fact.input_tokens), 0) AS input_tokens,
                coalesce(pg_catalog.sum(fact.output_tokens), 0) AS output_tokens,
                coalesce(pg_catalog.sum(fact.cached_tokens), 0) AS cached_tokens,
                coalesce(pg_catalog.sum(fact.input_tokens) FILTER (
                  WHERE fact.cached_tokens IS NOT NULL AND fact.input_tokens IS NOT NULL
                ), 0) AS cache_input_tokens,
                coalesce(pg_catalog.sum(fact.cache_write_tokens), 0) AS cache_write_tokens,
                coalesce(pg_catalog.sum(fact.total_tokens), 0) AS total_tokens,
                pg_catalog.count(fact.total_tokens) AS token_known_calls,
                pg_catalog.count(*) FILTER (
                  WHERE fact.cached_tokens IS NOT NULL AND fact.input_tokens IS NOT NULL
                ) AS cache_known_calls,
                coalesce(pg_catalog.sum(fact.priced_cost_micros) FILTER (
                  WHERE fact.billing_path = 'opengeni_credits'
                ), 0) AS credit_micros,
                coalesce(pg_catalog.sum(fact.estimated_provider_cost_micros), 0)
                  AS estimated_provider_micros,
                pg_catalog.count(fact.estimated_provider_cost_micros)
                  AS estimated_provider_known_calls
              FROM %1$I.model_call_facts fact
              INNER JOIN visible_sessions session_row
                ON session_row.account_id = fact.account_id
                AND session_row.workspace_id = fact.workspace_id
                AND session_row.id = fact.session_id
              WHERE fact.account_id = context_account_id
                AND fact.workspace_id = workspace_row.id
                AND fact.occurred_at >= p_since
                AND fact.occurred_at < p_until
              GROUP BY fact.provider, fact.model, fact.billing_path
            )
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'workspace_id', workspace_row.id, 'provider', provider, 'model', model,
              'billing_path', billing_path, 'calls', calls, 'input_tokens', input_tokens,
              'output_tokens', output_tokens, 'cached_tokens', cached_tokens,
              'cache_input_tokens', cache_input_tokens, 'cache_write_tokens', cache_write_tokens,
              'total_tokens', total_tokens, 'token_known_calls', token_known_calls,
              'cache_known_calls', cache_known_calls, 'credit_micros', credit_micros,
              'estimated_provider_micros', estimated_provider_micros,
              'estimated_provider_known_calls', estimated_provider_known_calls
            ))
            FROM grouped
          ), '[]'::jsonb);
          DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities
          WHERE backend_pid = pg_catalog.pg_backend_pid()
            AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
            AND capability_kind = 'model_call_facts';
        END LOOP;
        PERFORM pg_catalog.set_config('opengeni.workspace_id', '', true);
      EXCEPTION WHEN OTHERS THEN
        DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'model_call_facts';
        PERFORM pg_catalog.set_config('opengeni.workspace_id', '', true);
        RAISE;
      END;

      WITH fact AS (
        SELECT * FROM pg_catalog.jsonb_to_recordset(fact_rows) AS row_value(
          workspace_id uuid, provider text, model text, billing_path text, calls bigint,
          input_tokens bigint, output_tokens bigint, cached_tokens bigint,
          cache_input_tokens bigint, cache_write_tokens bigint, total_tokens bigint,
          token_known_calls bigint, cache_known_calls bigint, credit_micros bigint,
          estimated_provider_micros bigint, estimated_provider_known_calls bigint
        )
      ), grouped AS (
        SELECT
          grouping(fact.provider, fact.model) = 0 AS by_model,
          grouping(fact.workspace_id) = 0 AS by_workspace,
          grouping(personal) = 0 AS by_personal,
          fact.provider, fact.model, fact.workspace_id, personal, fact.billing_path,
          pg_catalog.jsonb_build_object(
            'billingPath', fact.billing_path,
            'calls', pg_catalog.sum(fact.calls)::text,
            'inputTokens', pg_catalog.sum(fact.input_tokens)::text,
            'outputTokens', pg_catalog.sum(fact.output_tokens)::text,
            'cachedTokens', pg_catalog.sum(fact.cached_tokens)::text,
            'cacheInputTokens', pg_catalog.sum(fact.cache_input_tokens)::text,
            'cacheWriteTokens', pg_catalog.sum(fact.cache_write_tokens)::text,
            'totalTokens', pg_catalog.sum(fact.total_tokens)::text,
            'tokenKnownCalls', pg_catalog.sum(fact.token_known_calls)::text,
            'cacheKnownCalls', pg_catalog.sum(fact.cache_known_calls)::text,
            'creditMicros', pg_catalog.sum(fact.credit_micros)::text,
            'estimatedProviderMicros', pg_catalog.sum(fact.estimated_provider_micros)::text,
            'estimatedProviderKnownCalls', pg_catalog.sum(fact.estimated_provider_known_calls)::text
          ) AS totals,
          pg_catalog.sum(fact.total_tokens) AS sort_tokens
        FROM (
          SELECT fact.*, NOT (fact.workspace_id = ANY(shared_ids)) AS personal FROM fact
        ) fact
        GROUP BY GROUPING SETS (
          (fact.billing_path),
          (fact.provider, fact.model, fact.billing_path),
          (fact.workspace_id, fact.billing_path),
          (personal, fact.billing_path)
        )
      ), models AS (
        SELECT provider, model, totals, sort_tokens
        FROM grouped WHERE by_model
        ORDER BY sort_tokens DESC, provider, model, billing_path
        LIMIT 51
      )
      SELECT pg_catalog.jsonb_build_object(
        'billing', coalesce((
          SELECT pg_catalog.jsonb_agg(totals ORDER BY billing_path)
          FROM grouped WHERE NOT by_model AND NOT by_workspace AND NOT by_personal
        ), '[]'::jsonb),
        'models', coalesce((
          SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'provider', provider, 'model', model, 'totals', totals
          ) ORDER BY sort_tokens DESC, provider, model)
          FROM (SELECT * FROM models ORDER BY sort_tokens DESC, provider, model LIMIT 50) listed
        ), '[]'::jsonb),
        'modelsTruncated', (SELECT pg_catalog.count(*) > 50 FROM models),
        'workspaces', coalesce((
          SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'workspaceId', workspace.id, 'name', workspace.name,
            'billing', coalesce((
              SELECT pg_catalog.jsonb_agg(grouped.totals ORDER BY grouped.billing_path)
              FROM grouped WHERE grouped.by_workspace AND grouped.workspace_id = workspace.id
            ), '[]'::jsonb)
          ) ORDER BY workspace.id)
          FROM %1$I.workspaces workspace
          WHERE workspace.account_id = context_account_id AND workspace.id = ANY(page_ids)
        ), '[]'::jsonb),
        'personal', pg_catalog.jsonb_build_object(
          'workspacesWithUsage', (
            SELECT pg_catalog.count(DISTINCT fact.workspace_id) FROM fact
            WHERE NOT (fact.workspace_id = ANY(shared_ids))
          )::text,
          'billing', coalesce((
            SELECT pg_catalog.jsonb_agg(totals ORDER BY billing_path)
            FROM grouped WHERE by_personal AND personal
          ), '[]'::jsonb)
        ),
        'nextWorkspaceCursor', next_cursor
      ) INTO response;
      RETURN response;
    END
    $function$;
    REVOKE ALL ON FUNCTION opengeni_private.organization_model_usage_summary(
      uuid, timestamp with time zone, timestamp with time zone, uuid
    ) FROM PUBLIC;
  $ddl$, data_schema);
END
$organization_model_usage$;

DO $organization_model_usage_acl$
DECLARE
  data_schema text := pg_catalog.current_schema();
  role_name text;
BEGIN
  FOR role_name IN
    SELECT DISTINCT grantee_role.rolname
    FROM pg_catalog.pg_proc procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) privilege
    INNER JOIN pg_catalog.pg_roles grantee_role ON grantee_role.oid = privilege.grantee
    WHERE procedure.oid = 'opengeni_private.organization_model_usage_summary(uuid,timestamptz,timestamptz,uuid)'::pg_catalog.regprocedure
      AND privilege.grantee <> procedure.proowner
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION opengeni_private.organization_model_usage_summary(uuid,timestamptz,timestamptz,uuid) FROM %I',
      role_name
    );
  END LOOP;
  FOR role_name IN
    SELECT role_row.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      pg_catalog.current_setting('opengeni.migration_application_roles')::jsonb
    ) configured(value)
    INNER JOIN pg_catalog.pg_roles role_row ON role_row.rolname = configured.value
    WHERE pg_catalog.has_table_privilege(role_row.rolname, pg_catalog.format('%I.model_call_facts', data_schema), 'SELECT')
      AND pg_catalog.has_table_privilege(role_row.rolname, pg_catalog.format('%I.sessions', data_schema), 'SELECT')
    ORDER BY role_row.rolname COLLATE "C"
  LOOP
    EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA opengeni_private TO %I', role_name);
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.organization_model_usage_summary(uuid,timestamptz,timestamptz,uuid) TO %I',
      role_name
    );
  END LOOP;
END
$organization_model_usage_acl$;

RESET statement_timeout;
RESET lock_timeout;
