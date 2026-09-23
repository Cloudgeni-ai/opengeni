-- deployment-mode: rolling
-- The bundle consumes four columns. A PL/pgSQL SETOF usage_events function
-- constructs/spills the entire row before its caller can project those columns.
-- Keep the 0359 authorization/window/filter/capability protocol unchanged and
-- expose a separate narrow result so existing full-row callers keep working.
DO $insights_usage_projection$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format($ddl$
    CREATE FUNCTION opengeni_private.visible_workspace_insights_usage_projection(
      p_workspace_id uuid,
      p_since timestamp with time zone,
      p_until timestamp with time zone,
      p_event_types text[]
    ) RETURNS TABLE (
      event_type text,
      quantity bigint,
      occurred_at timestamp with time zone,
      source_resource_id text
    )
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $function$
    DECLARE
      context_account_id uuid;
      context_workspace_id uuid;
      context_subject_id text;
      context_initiating_human_subject_id text;
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
      IF p_event_types IS NULL
        OR pg_catalog.array_ndims(p_event_types) <> 1
        OR pg_catalog.cardinality(p_event_types) < 1
        OR pg_catalog.cardinality(p_event_types) > 16
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(p_event_types) event_type(value)
          WHERE event_type.value IS NULL
            OR pg_catalog.btrim(event_type.value) = ''
            OR pg_catalog.octet_length(event_type.value) > 256
        )
        OR (
          SELECT pg_catalog.count(DISTINCT event_type.value COLLATE "C")
          FROM pg_catalog.unnest(p_event_types) event_type(value)
        ) <> pg_catalog.cardinality(p_event_types)
      THEN
        RAISE EXCEPTION 'Insights usage event types must contain 1-16 unique bounded values'
          USING ERRCODE = '22023';
      END IF;
      IF p_until = p_since THEN
        RETURN;
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
        'usage_events',
        context_account_id,
        context_workspace_id,
        context_subject_id,
        context_initiating_human_subject_id
      );
      BEGIN
        RETURN QUERY
        WITH visible_sessions AS MATERIALIZED (
          SELECT
            id, account_id, workspace_id, visibility,
            owner_organization_membership_id, owner_subject_id
          FROM %1$I.sessions
          WHERE account_id = context_account_id
            AND workspace_id = p_workspace_id
        )
        SELECT usage_row.event_type, usage_row.quantity,
          usage_row.occurred_at, usage_row.source_resource_id
        FROM %1$I.usage_events usage_row
        LEFT JOIN visible_sessions session_row
          ON session_row.account_id = usage_row.account_id
          AND session_row.workspace_id = usage_row.workspace_id
          AND session_row.id = usage_row.session_id
        WHERE usage_row.account_id = context_account_id
          AND usage_row.workspace_id = p_workspace_id
          AND usage_row.event_type = ANY (p_event_types)
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

        DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'usage_events';
        RETURN;
      EXCEPTION WHEN OTHERS THEN
        DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'usage_events';
        RAISE;
      END;
    END
    $function$;
    REVOKE ALL ON FUNCTION opengeni_private.visible_workspace_insights_usage_projection(
      uuid, timestamptz, timestamptz, text[]
    ) FROM PUBLIC;
  $ddl$, data_schema);
END
$insights_usage_projection$;

DO $insights_usage_projection_acl$
DECLARE
  role_name text;
  data_schema text := pg_catalog.current_schema();
BEGIN
  -- Strip owner-default grants before admitting only configured application
  -- roles that already have the existing full-row analytical authority.
  FOR role_name IN
    SELECT DISTINCT r.rolname FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) privilege
    JOIN pg_catalog.pg_roles r ON r.oid = privilege.grantee
    WHERE p.oid = 'opengeni_private.visible_workspace_insights_usage_projection(uuid,timestamptz,timestamptz,text[])'::regprocedure
      AND privilege.grantee <> p.proowner
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION opengeni_private.visible_workspace_insights_usage_projection(uuid,timestamptz,timestamptz,text[]) FROM %I', role_name);
  END LOOP;
  FOR role_name IN
    SELECT r.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      pg_catalog.current_setting('opengeni.migration_application_roles')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles r ON r.rolname = configured.value
    WHERE pg_catalog.has_function_privilege(r.rolname,
      'opengeni_private.visible_workspace_insights_usage_events(uuid,timestamptz,timestamptz,text[])', 'EXECUTE')
      AND pg_catalog.has_table_privilege(r.rolname, pg_catalog.format('%I.usage_events', data_schema), 'SELECT')
      AND pg_catalog.has_table_privilege(r.rolname, pg_catalog.format('%I.sessions', data_schema), 'SELECT')
  LOOP
    EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA opengeni_private TO %I', role_name);
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION opengeni_private.visible_workspace_insights_usage_projection(uuid,timestamptz,timestamptz,text[]) TO %I', role_name);
  END LOOP;
END
$insights_usage_projection_acl$;