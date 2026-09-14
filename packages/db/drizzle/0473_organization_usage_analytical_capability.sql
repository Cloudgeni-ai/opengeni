-- deployment-mode: rolling
-- Exact account-scoped reporting, retaining FORCE RLS and actual actor scope.
-- Only this aggregate function may mint the short-lived owner capability. It
-- never returns raw facts and does not change any write/tenant/session policy.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE opengeni_private.organization_usage_read_capabilities (
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  account_id uuid NOT NULL,
  subject_id text,
  initiating_human_subject_id text,
  PRIMARY KEY (backend_pid, transaction_id)
);
REVOKE ALL ON TABLE opengeni_private.organization_usage_read_capabilities FROM PUBLIC;

-- Strip hostile owner defaults, not merely the nominal application role.
DO $table_acl$
DECLARE role_name text;
BEGIN
  FOR role_name IN
    SELECT DISTINCT role_row.rolname
    FROM pg_catalog.pg_class relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(relation.relacl,
      pg_catalog.acldefault('r', relation.relowner))) privilege
    JOIN pg_catalog.pg_roles role_row ON role_row.oid = privilege.grantee
    WHERE relation.oid = 'opengeni_private.organization_usage_read_capabilities'::regclass
      AND privilege.grantee <> relation.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE opengeni_private.organization_usage_read_capabilities FROM %I', role_name);
  END LOOP;
END
$table_acl$;

DO $functions$
DECLARE data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.organization_usage_policy_capability_active(p_actor text)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog
    AS $fn$
      SELECT p_actor = pg_catalog.pg_get_userbyid((
        SELECT relowner FROM pg_catalog.pg_class
        WHERE oid = %2$L::pg_catalog.regclass
      )) AND nullif(pg_catalog.current_setting('opengeni.workspace_id', true), '') IS NULL
      AND EXISTS (
        SELECT 1 FROM opengeni_private.organization_usage_read_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.account_id::text IS NOT DISTINCT FROM nullif(pg_catalog.current_setting('opengeni.account_id', true), '')
          AND capability.subject_id IS NOT DISTINCT FROM nullif(pg_catalog.current_setting('opengeni.subject_id', true), '')
          AND capability.initiating_human_subject_id IS NOT DISTINCT FROM nullif(pg_catalog.current_setting('opengeni.initiating_human_subject_id', true), '')
      )
    $fn$;
    REVOKE ALL ON FUNCTION %1$I.organization_usage_policy_capability_active(text) FROM PUBLIC;
    -- RLS plans check function ACLs before short circuiting. This reveals only
    -- a same-backend boolean; callers cannot insert its capability row.
    GRANT EXECUTE ON FUNCTION %1$I.organization_usage_policy_capability_active(text) TO PUBLIC;

    CREATE FUNCTION opengeni_private.organization_usage_summary(
      p_account_id uuid, p_since timestamptz, p_until timestamptz,
      p_granularity text, p_after_workspace_id uuid, p_include_period boolean
    ) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    SET plan_cache_mode = force_custom_plan
    AS $fn$
    DECLARE
      context_account_id uuid;
      context_subject_id text;
      context_human_id text;
      page_ids uuid[];
      next_cursor uuid;
      response jsonb;
    BEGIN
      PERFORM opengeni_private.session_variable_set_attachments_protocol_v1_active();
      BEGIN
        context_account_id := nullif(current_setting('opengeni.account_id', true), '')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'Organization usage account context is malformed' USING ERRCODE = '42501';
      END;
      context_subject_id := nullif(current_setting('opengeni.subject_id', true), '');
      context_human_id := nullif(current_setting('opengeni.initiating_human_subject_id', true), '');
      IF context_account_id IS NULL OR context_account_id IS DISTINCT FROM p_account_id
        OR nullif(current_setting('opengeni.workspace_id', true), '') IS NOT NULL
      THEN
        RAISE EXCEPTION 'Organization usage requires the exact account-only context' USING ERRCODE = '42501';
      END IF;
      IF p_since IS NULL OR p_until IS NULL OR NOT isfinite(p_since) OR NOT isfinite(p_until)
        OR p_until < p_since OR p_until - p_since > interval '366 days'
        OR p_granularity IS NULL OR p_granularity NOT IN ('hour', 'day')
        OR (p_granularity = 'hour' AND p_until - p_since > interval '1 day')
        OR p_include_period IS NULL
      THEN
        RAISE EXCEPTION 'Organization usage window or granularity is invalid' USING ERRCODE = '22023';
      END IF;
      -- Match listSharedWorkspacesForAccount: canonical membership pointers
      -- exclude EVERY Personal workspace before lookahead/cursor selection.
      -- Names, kind guesses and caller-owned Personal exceptions are forbidden.
      -- Period totals remain actor-visible accounting across the account;
      -- this shared-only inventory deliberately need not sum to those totals.
      SELECT coalesce(array_agg(id ORDER BY id), '{}'::uuid[]) INTO page_ids
      FROM (SELECT id FROM %1$I.workspaces
        WHERE account_id = context_account_id
          AND id IN (SELECT workspace_id FROM %1$I.list_organization_workspace_ids(context_account_id))
          AND (p_after_workspace_id IS NULL OR id > p_after_workspace_id)
        ORDER BY id LIMIT 51) page;
      IF cardinality(page_ids) > 50 THEN
        next_cursor := page_ids[50];
        page_ids := page_ids[1:50];
      END IF;

      INSERT INTO opengeni_private.organization_usage_read_capabilities
        (backend_pid, transaction_id, account_id, subject_id, initiating_human_subject_id)
      VALUES (pg_backend_pid(), pg_current_xact_id(), context_account_id, context_subject_id, context_human_id);
      BEGIN
        WITH visible_sessions AS MATERIALIZED (
          -- Sessions retain ordinary FORCE RLS. Private actor checks occur
          -- once per session here, never once per fact in the aggregate scan.
          SELECT id, account_id, workspace_id FROM %1$I.sessions session_row
          WHERE account_id = context_account_id
            AND (p_include_period OR workspace_id = ANY(page_ids))
            AND (context_subject_id IS NULL OR visibility = 'workspace_shared'
              OR %1$I.session_private_actor_visible(account_id, workspace_id,
                owner_organization_membership_id, owner_subject_id))
        ), visible AS MATERIALIZED (
          SELECT usage_row.workspace_id, usage_row.event_type, usage_row.unit, usage_row.quantity,
            CASE WHEN p_include_period THEN to_char(date_trunc(p_granularity, usage_row.occurred_at AT TIME ZONE 'UTC'),
              CASE WHEN p_granularity = 'hour' THEN 'YYYY-MM-DD"T"HH24:00' ELSE 'YYYY-MM-DD' END) END AS bucket
          FROM %1$I.usage_events usage_row
          LEFT JOIN visible_sessions session_row
            ON session_row.id = usage_row.session_id
            AND session_row.account_id = usage_row.account_id
            AND session_row.workspace_id = usage_row.workspace_id
          WHERE usage_row.account_id = context_account_id
            AND usage_row.occurred_at >= p_since AND usage_row.occurred_at < p_until
            AND (p_include_period OR usage_row.workspace_id = ANY(page_ids))
            AND (usage_row.session_id IS NULL OR session_row.id IS NOT NULL)
        ), aggregates AS MATERIALIZED (
          SELECT workspace_id, bucket, grouping(workspace_id) AS all_workspaces,
            grouping(bucket) AS all_buckets,
            jsonb_build_object('eventType', event_type, 'unit', unit,
              'quantity', sum(quantity)::text, 'eventCount', count(*)::text) AS total
          FROM visible GROUP BY GROUPING SETS
            ((event_type, unit), (bucket, event_type, unit), (workspace_id, event_type, unit))
        ), bucket_rows AS (
          SELECT bucket, jsonb_agg(total ORDER BY total->>'eventType', total->>'unit') AS totals
          FROM aggregates WHERE all_buckets = 0 AND p_include_period GROUP BY bucket
        ), workspace_rows AS (
          SELECT workspace_id, jsonb_agg(total ORDER BY total->>'eventType', total->>'unit') AS totals
          FROM aggregates WHERE all_workspaces = 0 AND workspace_id = ANY(page_ids) GROUP BY workspace_id
        )
        SELECT jsonb_build_object(
          'totals', CASE WHEN p_include_period THEN coalesce((SELECT jsonb_agg(total ORDER BY total->>'eventType', total->>'unit')
            FROM aggregates WHERE all_workspaces = 1 AND all_buckets = 1), '[]'::jsonb) ELSE NULL END,
          'buckets', CASE WHEN p_include_period THEN coalesce((SELECT jsonb_agg(jsonb_build_object('bucket', bucket, 'totals', totals) ORDER BY bucket)
            FROM bucket_rows), '[]'::jsonb) ELSE NULL END,
          'workspaces', coalesce((SELECT jsonb_agg(jsonb_build_object('workspaceId', w.id, 'name', w.name,
            'totals', coalesce(r.totals, '[]'::jsonb)) ORDER BY w.id)
            FROM %1$I.workspaces w LEFT JOIN workspace_rows r ON r.workspace_id = w.id
            WHERE w.account_id = context_account_id AND w.id = ANY(page_ids)), '[]'::jsonb),
          'nextWorkspaceCursor', next_cursor
        ) INTO response;

        DELETE FROM opengeni_private.organization_usage_read_capabilities
          WHERE backend_pid = pg_backend_pid() AND transaction_id = pg_current_xact_id_if_assigned();
        RETURN response;
      EXCEPTION WHEN OTHERS THEN
        DELETE FROM opengeni_private.organization_usage_read_capabilities
          WHERE backend_pid = pg_backend_pid() AND transaction_id = pg_current_xact_id_if_assigned();
        RAISE;
      END;
    END
    $fn$;
    REVOKE ALL ON FUNCTION opengeni_private.organization_usage_summary(uuid,timestamptz,timestamptz,text,uuid,boolean) FROM PUBLIC;
  $ddl$, data_schema, format('%I.usage_events', data_schema));
END
$functions$;

DO $policy$
DECLARE data_schema text := current_schema(); installed record; expected_expression text;
BEGIN
  SELECT p.polpermissive, p.polcmd, pg_get_expr(p.polqual, p.polrelid) AS expression INTO installed
  FROM pg_policy p WHERE p.polrelid = format('%I.usage_events', data_schema)::regclass
    AND p.polname = 'session_visibility_isolation';
  IF NOT FOUND OR installed.polpermissive OR installed.polcmd <> 'r'
    OR installed.expression IS NULL
  THEN
    RAISE EXCEPTION 'Organization usage refuses unknown fact visibility policy' USING ERRCODE = '55000';
  END IF;
  -- Compare parsed policy trees, not substring heuristics. This temporary,
  -- equally restrictive policy is dropped before the atomic migration ends.
  -- A future visibility change must be reconciled explicitly rather than
  -- silently replaced by a capability for a different authorization rule.
  EXECUTE format('CREATE POLICY organization_usage_expected_visibility ON %1$I.usage_events AS RESTRICTIVE FOR SELECT USING (
    CASE WHEN %1$I.insights_fact_read_policy_capability_active(current_user,
      pg_catalog.pg_get_userbyid((SELECT relation.relowner FROM pg_catalog.pg_class relation WHERE relation.oid = %2$L::pg_catalog.regclass)),
      ''usage_events'') THEN true ELSE %1$I.session_reference_visible(account_id, workspace_id, session_id) END)',
    data_schema, format('%I.usage_events', data_schema));
  SELECT pg_get_expr(p.polqual, p.polrelid) INTO expected_expression FROM pg_policy p
    WHERE p.polrelid = format('%I.usage_events', data_schema)::regclass
      AND p.polname = 'organization_usage_expected_visibility';
  EXECUTE format('DROP POLICY organization_usage_expected_visibility ON %I.usage_events', data_schema);
  IF installed.expression IS DISTINCT FROM expected_expression THEN
    RAISE EXCEPTION 'Organization usage refuses changed fact visibility semantics' USING ERRCODE = '55000';
  END IF;
  -- The cheap owner-capability initPlan comes first; normal callers retain the
  -- complete existing expression. Only SELECT changes; all writes stay intact.
  EXECUTE format('ALTER POLICY session_visibility_isolation ON %I.usage_events USING (CASE WHEN (SELECT %I.organization_usage_policy_capability_active(current_user)) THEN true ELSE (%s) END)',
    data_schema, data_schema, installed.expression);
END
$policy$;

DO $function_acl$
DECLARE role_name text; data_schema text := current_schema();
BEGIN
  FOR role_name IN
    SELECT DISTINCT r.rolname FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
    JOIN pg_roles r ON r.oid = privilege.grantee
    WHERE p.oid = 'opengeni_private.organization_usage_summary(uuid,timestamptz,timestamptz,text,uuid,boolean)'::regprocedure
      AND privilege.grantee <> p.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.organization_usage_summary(uuid,timestamptz,timestamptz,text,uuid,boolean) FROM %I', role_name);
  END LOOP;
  FOR role_name IN
    SELECT r.rolname FROM jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) configured(value)
    JOIN pg_roles r ON r.rolname = configured.value
    WHERE has_table_privilege(r.rolname, format('%I.usage_events', data_schema), 'SELECT')
      AND has_table_privilege(r.rolname, format('%I.sessions', data_schema), 'SELECT')
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA opengeni_private TO %I', role_name);
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.organization_usage_summary(uuid,timestamptz,timestamptz,text,uuid,boolean) TO %I', role_name);
  END LOOP;
END
$function_acl$;