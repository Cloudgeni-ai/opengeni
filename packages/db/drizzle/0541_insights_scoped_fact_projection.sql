-- deployment-mode: rolling
-- Workspace Insights read every visible fact in the window through the full-row
-- SETOF model_call_facts functions (0359/0512), then filtered a root-session or
-- session drilldown afterwards and re-joined sessions just to derive each fact's
-- root. At 1.5M facts a scoped read cost as much as the unscoped one (10s+).
--
-- This additive function returns only the columns the bundle consumes plus the
-- fact's root session, which the visible-session join already has. A root or
-- session scope narrows that same visible-session set first, so the read seeks
-- sessions_workspace_root_depth_idx and model_call_facts_workspace_session_occurred_idx
-- instead of scanning the window. The context, window, filter, visibility, and
-- capability protocol is the 0359 protocol unchanged; the released functions and
-- their grants are untouched, so older application images keep working.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $insights_scoped_fact_projection$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format($ddl$
    CREATE FUNCTION opengeni_private.visible_workspace_insights_model_fact_rows(
      p_workspace_id uuid,
      p_since timestamp with time zone,
      p_until timestamp with time zone,
      p_provider text,
      p_model text,
      p_root_session_id uuid,
      p_session_id uuid
    ) RETURNS TABLE (
      id uuid,
      session_id uuid,
      root_session_id uuid,
      turn_id uuid,
      provider text,
      provider_api text,
      model text,
      billing_path text,
      scheduled_task_id uuid,
      input_tokens bigint,
      output_tokens bigint,
      cached_tokens bigint,
      cache_write_tokens bigint,
      reasoning_tokens bigint,
      total_tokens bigint,
      priced_cost_micros bigint,
      estimated_provider_cost_micros bigint,
      equivalent_credit_cost_micros bigint,
      pricing_source text,
      context_contributions jsonb,
      occurred_at timestamp with time zone,
      recorded_at timestamp with time zone
    )
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    SET enable_nestloop = off
    AS $function$
    DECLARE
      context_account_id uuid;
      context_workspace_id uuid;
      context_subject_id text;
      context_initiating_human_subject_id text;
      session_predicates text := '';
      fact_predicates text := '';
    BEGIN
      PERFORM opengeni_private.session_variable_set_attachments_protocol_v1_active();
      BEGIN
        context_account_id := nullif(
          pg_catalog.current_setting('opengeni.account_id', true), ''
        )::uuid;
        context_workspace_id := nullif(
          pg_catalog.current_setting('opengeni.workspace_id', true), ''
        )::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'Insights RLS context is malformed'
          USING ERRCODE = '42501';
      END;
      context_subject_id := nullif(
        pg_catalog.current_setting('opengeni.subject_id', true), ''
      );
      context_initiating_human_subject_id := nullif(
        pg_catalog.current_setting('opengeni.initiating_human_subject_id', true), ''
      );
      IF context_account_id IS NULL
        OR context_workspace_id IS NULL
        OR context_workspace_id IS DISTINCT FROM p_workspace_id
      THEN
        RAISE EXCEPTION 'Insights RLS context does not match the requested workspace'
          USING ERRCODE = '42501';
      END IF;
      IF p_since IS NULL
        OR p_until IS NULL
        OR p_since IN (
          '-infinity'::timestamp with time zone,
          'infinity'::timestamp with time zone
        )
        OR p_until = '-infinity'::timestamp with time zone
        OR p_until < p_since
        OR (
          p_until <> 'infinity'::timestamp with time zone
          AND p_until - p_since > interval '370 days'
        )
        OR (
          p_until = 'infinity'::timestamp with time zone
          AND p_since < CURRENT_TIMESTAMP - interval '370 days'
        )
      THEN
        RAISE EXCEPTION 'Insights fact window must be non-negative and at most 370 days'
          USING ERRCODE = '22023';
      END IF;
      IF (p_provider IS NOT NULL AND (
          pg_catalog.btrim(p_provider) = ''
          OR pg_catalog.octet_length(p_provider) > 256
        ))
        OR (p_model IS NOT NULL AND (
          pg_catalog.btrim(p_model) = ''
          OR pg_catalog.octet_length(p_model) > 512
        ))
      THEN
        RAISE EXCEPTION 'Insights model filters are invalid'
          USING ERRCODE = '22023';
      END IF;
      IF p_until = p_since THEN
        RETURN;
      END IF;

      -- Only the shape of the statement varies; every value is a bound
      -- parameter, and each call is planned for its own selectivity.
      IF p_provider IS NOT NULL THEN
        fact_predicates := fact_predicates || ' AND fact.provider = $5';
      END IF;
      IF p_model IS NOT NULL THEN
        fact_predicates := fact_predicates || ' AND fact.model = $6';
      END IF;
      IF p_root_session_id IS NOT NULL THEN
        session_predicates := session_predicates || ' AND root_session_id = $7';
      END IF;
      IF p_session_id IS NOT NULL THEN
        session_predicates := session_predicates || ' AND id = $8';
      END IF;
      -- A scoped read is a handful of sessions; let it seek facts by session.
      -- The unscoped window keeps the 0512 hash-join-only plan.
      IF p_root_session_id IS NOT NULL OR p_session_id IS NOT NULL THEN
        PERFORM pg_catalog.set_config('enable_nestloop', 'on', true);
      END IF;

      INSERT INTO opengeni_private.insights_fact_read_runtime_capabilities (
        backend_pid,
        transaction_id,
        capability_kind,
        account_id,
        workspace_id,
        subject_id,
        initiating_human_subject_id
      ) VALUES (
        pg_catalog.pg_backend_pid(),
        pg_catalog.pg_current_xact_id(),
        'model_call_facts',
        context_account_id,
        context_workspace_id,
        context_subject_id,
        context_initiating_human_subject_id
      );
      BEGIN
        RETURN QUERY EXECUTE pg_catalog.format(
          'WITH visible_sessions AS MATERIALIZED (
            SELECT
              id, account_id, workspace_id, root_session_id, visibility,
              owner_organization_membership_id, owner_subject_id
            FROM %%1$I.sessions
            WHERE account_id = $1
              AND workspace_id = $2%%2$s
          )
          SELECT
            fact.id, fact.session_id, session_row.root_session_id, fact.turn_id,
            fact.provider, fact.provider_api, fact.model, fact.billing_path,
            fact.scheduled_task_id, fact.input_tokens, fact.output_tokens,
            fact.cached_tokens, fact.cache_write_tokens, fact.reasoning_tokens,
            fact.total_tokens, fact.priced_cost_micros,
            fact.estimated_provider_cost_micros, fact.equivalent_credit_cost_micros,
            fact.pricing_source, fact.context_contributions, fact.occurred_at,
            fact.recorded_at
          FROM %%1$I.model_call_facts fact
          INNER JOIN visible_sessions session_row
            ON session_row.account_id = fact.account_id
            AND session_row.workspace_id = fact.workspace_id
            AND session_row.id = fact.session_id
          WHERE fact.account_id = $1
            AND fact.workspace_id = $2
            AND fact.occurred_at >= $3
            AND fact.occurred_at < $4%%3$s
            AND (
              $9::text IS NULL
              OR session_row.visibility = ''workspace_shared''
              OR %%1$I.session_private_actor_visible(
                session_row.account_id,
                session_row.workspace_id,
                session_row.owner_organization_membership_id,
                session_row.owner_subject_id
              )
            )',
          %1$L,
          session_predicates,
          fact_predicates
        )
        USING context_account_id, p_workspace_id, p_since, p_until,
          p_provider, p_model, p_root_session_id, p_session_id, context_subject_id;

        DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'model_call_facts';
        RETURN;
      EXCEPTION WHEN OTHERS THEN
        DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'model_call_facts';
        RAISE;
      END;
    END
    $function$;
    REVOKE ALL ON FUNCTION opengeni_private.visible_workspace_insights_model_fact_rows(
      uuid, timestamp with time zone, timestamp with time zone, text, text, uuid, uuid
    ) FROM PUBLIC;
  $ddl$, data_schema);
END
$insights_scoped_fact_projection$;

-- Owner default privileges may have admitted other roles at creation. Reset every
-- non-owner grantee, then grant only the configured application roles that 0356/0359
-- already admit to the fact reads (SELECT on both fact tables).
DO $insights_scoped_fact_projection_acl$
DECLARE
  data_schema text := pg_catalog.current_schema();
  role_name text;
BEGIN
  FOR role_name IN
    SELECT grantee_role.rolname
    FROM pg_catalog.pg_proc procedure
    INNER JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) privilege
    INNER JOIN pg_catalog.pg_roles grantee_role
      ON grantee_role.oid = privilege.grantee
    WHERE namespace.nspname = 'opengeni_private'
      AND procedure.proname = 'visible_workspace_insights_model_fact_rows'
      AND privilege.grantee <> 0
      AND privilege.grantee <> procedure.proowner
    GROUP BY grantee_role.rolname
    ORDER BY grantee_role.rolname COLLATE "C"
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION opengeni_private.visible_workspace_insights_model_fact_rows('
        || 'uuid, timestamp with time zone, timestamp with time zone, text, text, uuid, uuid'
        || ') FROM %I',
      role_name
    );
  END LOOP;
  FOR role_name IN
    SELECT role_row.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      pg_catalog.current_setting('opengeni.migration_application_roles')::jsonb
    ) configured(value)
    INNER JOIN pg_catalog.pg_roles role_row
      ON role_row.rolname = configured.value
    WHERE pg_catalog.has_table_privilege(
        role_row.rolname,
        pg_catalog.format('%I.model_call_facts', data_schema),
        'SELECT'
      )
      AND pg_catalog.has_table_privilege(
        role_row.rolname,
        pg_catalog.format('%I.usage_events', data_schema),
        'SELECT'
      )
    ORDER BY role_row.rolname COLLATE "C"
  LOOP
    EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA opengeni_private TO %I', role_name);
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.visible_workspace_insights_model_fact_rows('
        || 'uuid, timestamp with time zone, timestamp with time zone, text, text, uuid, uuid'
        || ') TO %I',
      role_name
    );
  END LOOP;
END
$insights_scoped_fact_projection_acl$;

RESET statement_timeout;
RESET lock_timeout;
