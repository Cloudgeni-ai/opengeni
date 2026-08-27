-- deployment-mode: rolling
-- Insights scans model_call_facts and usage_events across thousands of rows.
-- Their ordinary restrictive policies deliberately call
-- session_reference_visible() for each row, which is correct for point reads
-- but makes analytical scans execute one nested sessions lookup per fact. Keep
-- those table policies unchanged for every ordinary caller. These two bounded
-- read-only functions reproduce the same account/workspace/subject visibility
-- rule inside one set-based join and expose no data outside the existing fact
-- shapes. Only roles that already SELECT both fact tables receive EXECUTE.
DO $set_based_insights_session_visibility_functions$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.visible_workspace_insights_model_call_facts(
      p_workspace_id uuid,
      p_since timestamp with time zone,
      p_until timestamp with time zone
    ) RETURNS SETOF %1$I.model_call_facts
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $function$
    DECLARE
      context_account_id uuid;
      context_workspace_id uuid;
      context_subject_id text;
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
      IF context_account_id IS NULL
        OR context_workspace_id IS NULL
        OR context_workspace_id <> p_workspace_id
      THEN
        RAISE EXCEPTION 'Insights RLS context does not match the requested workspace'
          USING ERRCODE = '42501';
      END IF;
      IF p_since IS NULL
        OR p_until IS NULL
        OR p_until <= p_since
        OR (
          p_until <> 'infinity'::timestamp with time zone
          AND p_until - p_since > interval '370 days'
        )
        OR (
          p_until = 'infinity'::timestamp with time zone
          AND p_since < CURRENT_TIMESTAMP - interval '370 days'
        )
      THEN
        RAISE EXCEPTION 'Insights fact window must be positive and at most 370 days'
          USING ERRCODE = '22023';
      END IF;

      RETURN QUERY
      SELECT fact.*
      FROM %1$I.model_call_facts fact
      INNER JOIN %1$I.sessions session_row
        ON session_row.account_id = fact.account_id
        AND session_row.workspace_id = fact.workspace_id
        AND session_row.id = fact.session_id
      WHERE fact.account_id = context_account_id
        AND fact.workspace_id = p_workspace_id
        AND fact.occurred_at >= p_since
        AND fact.occurred_at < p_until
        AND (
          context_subject_id IS NULL
          OR session_row.visibility = 'workspace_shared'
          OR %1$I.session_private_actor_visible(
            session_row.account_id,
            session_row.workspace_id,
            session_row.owner_organization_membership_id,
            session_row.owner_subject_id
          )
        );
    END
    $function$;
  $ddl$, data_schema);

  EXECUTE pg_catalog.format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.visible_workspace_insights_usage_events(
      p_workspace_id uuid,
      p_since timestamp with time zone,
      p_until timestamp with time zone
    ) RETURNS SETOF %1$I.usage_events
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $function$
    DECLARE
      context_account_id uuid;
      context_workspace_id uuid;
      context_subject_id text;
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
      IF context_account_id IS NULL
        OR context_workspace_id IS NULL
        OR context_workspace_id <> p_workspace_id
      THEN
        RAISE EXCEPTION 'Insights RLS context does not match the requested workspace'
          USING ERRCODE = '42501';
      END IF;
      IF p_since IS NULL
        OR p_until IS NULL
        OR p_until <= p_since
        OR (
          p_until <> 'infinity'::timestamp with time zone
          AND p_until - p_since > interval '370 days'
        )
        OR (
          p_until = 'infinity'::timestamp with time zone
          AND p_since < CURRENT_TIMESTAMP - interval '370 days'
        )
      THEN
        RAISE EXCEPTION 'Insights fact window must be positive and at most 370 days'
          USING ERRCODE = '22023';
      END IF;

      RETURN QUERY
      SELECT usage_row.*
      FROM %1$I.usage_events usage_row
      LEFT JOIN %1$I.sessions session_row
        ON session_row.account_id = usage_row.account_id
        AND session_row.workspace_id = usage_row.workspace_id
        AND session_row.id = usage_row.session_id
      WHERE usage_row.account_id = context_account_id
        AND usage_row.workspace_id = p_workspace_id
        AND usage_row.occurred_at >= p_since
        AND usage_row.occurred_at < p_until
        AND (
          usage_row.session_id IS NULL
          OR (
            session_row.id IS NOT NULL
            AND (
              context_subject_id IS NULL
              OR session_row.visibility = 'workspace_shared'
              OR %1$I.session_private_actor_visible(
                session_row.account_id,
                session_row.workspace_id,
                session_row.owner_organization_membership_id,
                session_row.owner_subject_id
              )
            )
          )
        );
    END
    $function$;
  $ddl$, data_schema);
END
$set_based_insights_session_visibility_functions$;

REVOKE ALL ON FUNCTION
  opengeni_private.visible_workspace_insights_model_call_facts(
    uuid, timestamp with time zone, timestamp with time zone
  )
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.visible_workspace_insights_usage_events(
    uuid, timestamp with time zone, timestamp with time zone
  )
FROM PUBLIC;

-- Rolling compatibility is limited to the explicitly configured application
-- roles. Do not infer application authority from fact-table SELECT: operator,
-- export, or reporting roles may intentionally lack sessions/private-schema
-- access even when they can inspect these fact tables through ordinary RLS.
DO $set_based_insights_session_visibility_grants$
DECLARE
  data_schema text := pg_catalog.current_schema();
  role_name text;
BEGIN
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
    EXECUTE pg_catalog.format(
      'GRANT USAGE ON SCHEMA opengeni_private TO %I',
      role_name
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION '
        || 'opengeni_private.visible_workspace_insights_model_call_facts('
        || 'uuid, timestamp with time zone, timestamp with time zone) TO %I',
      role_name
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION '
        || 'opengeni_private.visible_workspace_insights_usage_events('
        || 'uuid, timestamp with time zone, timestamp with time zone) TO %I',
      role_name
    );
  END LOOP;
END
$set_based_insights_session_visibility_grants$;
