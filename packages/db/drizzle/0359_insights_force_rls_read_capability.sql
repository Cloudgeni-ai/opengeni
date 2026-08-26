-- deployment-mode: rolling
-- Migration 0356 moved Insights visibility into set-based SECURITY DEFINER
-- scans, but a production migration owner is deliberately NOSUPERUSER and
-- NOBYPASSRLS. FORCE RLS therefore still ran the restrictive scalar
-- session_reference_visible() predicate once per fact. Open one exact,
-- transaction-local read capability while each audited function is active and
-- add that owner-only capability only to the SELECT form of the two fact-table
-- visibility policies. Sessions retain their ordinary policy, and every fact
-- write keeps the original predicate. The capability is a private row bound to
-- backend PID + xid + exact tenant/actor context, not a caller-forgeable GUC.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE opengeni_private.insights_fact_read_runtime_capabilities (
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  capability_kind text NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  subject_id text,
  initiating_human_subject_id text,
  created_at timestamp with time zone NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT insights_fact_read_runtime_capabilities_kind_chk CHECK (
    capability_kind IN ('model_call_facts', 'usage_events')
  ),
  CONSTRAINT insights_fact_read_runtime_capabilities_pk PRIMARY KEY (
    backend_pid, transaction_id, capability_kind
  )
);

REVOKE ALL ON TABLE
  opengeni_private.insights_fact_read_runtime_capabilities
FROM PUBLIC;

-- Owner ALTER DEFAULT PRIVILEGES may have admitted arbitrary roles before this
-- migration. Strip every explicit non-owner table grantee before constructing
-- the allow-list from the configured application roles below.
DO $insights_fact_read_capability_table_acl_reset$
DECLARE
  role_name text;
BEGIN
  FOR role_name IN
    SELECT grantee_role.rolname
    FROM pg_catalog.pg_class relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) privilege
    INNER JOIN pg_catalog.pg_roles grantee_role
      ON grantee_role.oid = privilege.grantee
    WHERE relation.oid =
        'opengeni_private.insights_fact_read_runtime_capabilities'::pg_catalog.regclass
      AND privilege.grantee <> 0
      AND privilege.grantee <> relation.relowner
    GROUP BY grantee_role.rolname
    ORDER BY grantee_role.rolname COLLATE "C"
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON TABLE '
        || 'opengeni_private.insights_fact_read_runtime_capabilities FROM %I',
      role_name
    );
  END LOOP;
END
$insights_fact_read_capability_table_acl_reset$;

-- PostgreSQL checks EXECUTE on every function referenced by an RLS policy
-- before it can short-circuit an owner-only branch. Put the value-free policy
-- guard in the fact-table schema and make only that guard public, so ordinary
-- reporting roles can keep using scalar fact visibility without widening
-- their private-schema ACLs or receiving EXECUTE on either analytical entry
-- point. A direct caller can spoof the two role arguments, but can only observe
-- a same-backend, same-transaction capability that it cannot mint.
DO $insights_fact_read_policy_capability_function$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.insights_fact_read_policy_capability_active(
      p_actor text,
      p_expected_owner text,
      p_capability_kind text
    ) RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
      SELECT p_actor = p_expected_owner AND EXISTS (
        SELECT 1
        FROM opengeni_private.insights_fact_read_runtime_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = p_capability_kind
          AND capability.account_id IS NOT DISTINCT FROM nullif(
            pg_catalog.current_setting('opengeni.account_id', true), ''
          )::uuid
          AND capability.workspace_id IS NOT DISTINCT FROM nullif(
            pg_catalog.current_setting('opengeni.workspace_id', true), ''
          )::uuid
          AND capability.subject_id IS NOT DISTINCT FROM nullif(
            pg_catalog.current_setting('opengeni.subject_id', true), ''
          )
          AND capability.initiating_human_subject_id IS NOT DISTINCT FROM nullif(
            pg_catalog.current_setting(
              'opengeni.initiating_human_subject_id', true
            ), ''
          )
        )
    $function$;
    REVOKE ALL ON FUNCTION
      %1$I.insights_fact_read_policy_capability_active(text, text, text)
    FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION
      %1$I.insights_fact_read_policy_capability_active(text, text, text)
    TO PUBLIC;
  $ddl$, data_schema);
END
$insights_fact_read_policy_capability_function$;

-- Split the existing restrictive FOR ALL policy into command-specific forms.
-- SELECT alone receives the owner+private-capability alternative. INSERT,
-- UPDATE, and DELETE retain the exact installed expression, including all
-- session-tenancy owner/fence behavior on sessions. Refuse definition drift
-- instead of weakening an unknown future policy.
DO $insights_fact_read_select_policies$
DECLARE
  data_schema text := pg_catalog.current_schema();
  target record;
  installed record;
  capability_expression text;
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      ('model_call_facts'::text, 'model_call_facts'::text),
      ('usage_events'::text, 'usage_events'::text)
    ) target_row(table_name, capability_kind)
  LOOP
    SELECT
      policy.polpermissive AS permissive,
      policy.polcmd AS command,
      pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) AS using_expression,
      pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) AS check_expression
    INTO installed
    FROM pg_catalog.pg_policy policy
    INNER JOIN pg_catalog.pg_class relation ON relation.oid = policy.polrelid
    INNER JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = data_schema
      AND relation.relname = target.table_name
      AND policy.polname = 'session_visibility_isolation';

    IF NOT FOUND
      OR installed.permissive
      OR installed.command <> '*'
      OR installed.using_expression IS NULL
      OR installed.check_expression IS DISTINCT FROM installed.using_expression
    THEN
      RAISE EXCEPTION '0359 unexpected session visibility policy on %.%',
        data_schema, target.table_name
        USING ERRCODE = '55000';
    END IF;

    capability_expression := pg_catalog.format(
      '%1$I.insights_fact_read_policy_capability_active('
        || 'current_user, pg_catalog.pg_get_userbyid(('
        || 'SELECT relation.relowner FROM pg_catalog.pg_class relation '
        || 'WHERE relation.oid = %2$L::pg_catalog.regclass)), %3$L)',
      data_schema,
      pg_catalog.format('%I.%I', data_schema, target.table_name),
      target.capability_kind
    );

    EXECUTE pg_catalog.format(
      'DROP POLICY session_visibility_isolation ON %I.%I',
      data_schema,
      target.table_name
    );
    EXECUTE pg_catalog.format(
      'DROP POLICY IF EXISTS session_visibility_insert_isolation ON %I.%I',
      data_schema,
      target.table_name
    );
    EXECUTE pg_catalog.format(
      'DROP POLICY IF EXISTS session_visibility_update_isolation ON %I.%I',
      data_schema,
      target.table_name
    );
    EXECUTE pg_catalog.format(
      'DROP POLICY IF EXISTS session_visibility_delete_isolation ON %I.%I',
      data_schema,
      target.table_name
    );

    EXECUTE pg_catalog.format(
      'CREATE POLICY session_visibility_isolation ON %I.%I AS RESTRICTIVE '
        || 'FOR SELECT USING (CASE WHEN (%s) THEN true ELSE (%s) END)',
      data_schema,
      target.table_name,
      capability_expression,
      installed.using_expression
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY session_visibility_insert_isolation ON %I.%I AS RESTRICTIVE '
        || 'FOR INSERT WITH CHECK (%s)',
      data_schema,
      target.table_name,
      installed.check_expression
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY session_visibility_update_isolation ON %I.%I AS RESTRICTIVE '
        || 'FOR UPDATE USING (%s) WITH CHECK (%s)',
      data_schema,
      target.table_name,
      installed.using_expression,
      installed.check_expression
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY session_visibility_delete_isolation ON %I.%I AS RESTRICTIVE '
        || 'FOR DELETE USING (%s)',
      data_schema,
      target.table_name,
      installed.using_expression
    );
  END LOOP;
END
$insights_fact_read_select_policies$;

DO $insights_model_fact_read_functions$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.visible_workspace_insights_model_call_facts(
      p_workspace_id uuid,
      p_since timestamp with time zone,
      p_until timestamp with time zone,
      p_provider text,
      p_model text
    ) RETURNS SETOF %1$I.model_call_facts
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
        -- Keep each nullability shape static. A cached generic PL/pgSQL plan
        -- for nullable OR predicates can abandon the selective
        -- workspace/provider/model/occurred_at index after repeated calls.
        IF p_provider IS NULL AND p_model IS NULL THEN
          RETURN QUERY
          WITH visible_sessions AS MATERIALIZED (
            SELECT
              id, account_id, workspace_id, visibility,
              owner_organization_membership_id, owner_subject_id
            FROM %1$I.sessions
            WHERE account_id = context_account_id
              AND workspace_id = p_workspace_id
          )
          SELECT fact.*
          FROM %1$I.model_call_facts fact
          INNER JOIN visible_sessions session_row
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
        ELSIF p_provider IS NOT NULL AND p_model IS NULL THEN
          RETURN QUERY
          WITH visible_sessions AS MATERIALIZED (
            SELECT
              id, account_id, workspace_id, visibility,
              owner_organization_membership_id, owner_subject_id
            FROM %1$I.sessions
            WHERE account_id = context_account_id
              AND workspace_id = p_workspace_id
          )
          SELECT fact.*
          FROM %1$I.model_call_facts fact
          INNER JOIN visible_sessions session_row
            ON session_row.account_id = fact.account_id
            AND session_row.workspace_id = fact.workspace_id
            AND session_row.id = fact.session_id
          WHERE fact.account_id = context_account_id
            AND fact.workspace_id = p_workspace_id
            AND fact.provider = p_provider
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
        ELSIF p_provider IS NULL AND p_model IS NOT NULL THEN
          RETURN QUERY
          WITH visible_sessions AS MATERIALIZED (
            SELECT
              id, account_id, workspace_id, visibility,
              owner_organization_membership_id, owner_subject_id
            FROM %1$I.sessions
            WHERE account_id = context_account_id
              AND workspace_id = p_workspace_id
          )
          SELECT fact.*
          FROM %1$I.model_call_facts fact
          INNER JOIN visible_sessions session_row
            ON session_row.account_id = fact.account_id
            AND session_row.workspace_id = fact.workspace_id
            AND session_row.id = fact.session_id
          WHERE fact.account_id = context_account_id
            AND fact.workspace_id = p_workspace_id
            AND fact.model = p_model
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
        ELSE
          RETURN QUERY
          WITH visible_sessions AS MATERIALIZED (
            SELECT
              id, account_id, workspace_id, visibility,
              owner_organization_membership_id, owner_subject_id
            FROM %1$I.sessions
            WHERE account_id = context_account_id
              AND workspace_id = p_workspace_id
          )
          SELECT fact.*
          FROM %1$I.model_call_facts fact
          INNER JOIN visible_sessions session_row
            ON session_row.account_id = fact.account_id
            AND session_row.workspace_id = fact.workspace_id
            AND session_row.id = fact.session_id
          WHERE fact.account_id = context_account_id
            AND fact.workspace_id = p_workspace_id
            AND fact.provider = p_provider
            AND fact.model = p_model
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
        END IF;

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
  $ddl$, data_schema);

  EXECUTE pg_catalog.format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.visible_workspace_insights_model_call_facts(
      p_workspace_id uuid,
      p_since timestamp with time zone,
      p_until timestamp with time zone
    ) RETURNS SETOF %1$I.model_call_facts
    LANGUAGE sql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $function$
      SELECT *
      FROM opengeni_private.visible_workspace_insights_model_call_facts(
        p_workspace_id, p_since, p_until, NULL, NULL
      )
    $function$;
  $ddl$, data_schema);
END
$insights_model_fact_read_functions$;

DO $insights_usage_fact_read_functions$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.visible_workspace_insights_usage_events(
      p_workspace_id uuid,
      p_since timestamp with time zone,
      p_until timestamp with time zone
    ) RETURNS SETOF %1$I.usage_events
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
        SELECT usage_row.*
        FROM %1$I.usage_events usage_row
        LEFT JOIN visible_sessions session_row
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
  $ddl$, data_schema);

  EXECUTE pg_catalog.format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.visible_workspace_insights_usage_events(
      p_workspace_id uuid,
      p_since timestamp with time zone,
      p_until timestamp with time zone,
      p_event_types text[]
    ) RETURNS SETOF %1$I.usage_events
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
        SELECT usage_row.*
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
  $ddl$, data_schema);
END
$insights_usage_fact_read_functions$;

REVOKE ALL ON FUNCTION
  opengeni_private.visible_workspace_insights_model_call_facts(
    uuid, timestamp with time zone, timestamp with time zone
  )
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.visible_workspace_insights_model_call_facts(
    uuid, timestamp with time zone, timestamp with time zone, text, text
  )
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.visible_workspace_insights_usage_events(
    uuid, timestamp with time zone, timestamp with time zone
  )
FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.visible_workspace_insights_usage_events(
    uuid, timestamp with time zone, timestamp with time zone, text[]
  )
FROM PUBLIC;

-- All entry points are subject to explicit or owner-default ACL drift. Reset
-- every non-owner grantee, including the released functions, then rebuild the
-- allow-list only from the migration runner's exact configured application
-- roles and 0356's dual-fact-SELECT eligibility rule.
DO $insights_fact_read_function_acl_reset$
DECLARE
  role_name text;
  target record;
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      (
        'visible_workspace_insights_model_call_facts'::text,
        'p_workspace_id uuid, p_since timestamp with time zone, p_until timestamp with time zone'::text,
        'uuid, timestamp with time zone, timestamp with time zone'::text
      ),
      (
        'visible_workspace_insights_model_call_facts'::text,
        'p_workspace_id uuid, p_since timestamp with time zone, p_until timestamp with time zone, p_provider text, p_model text'::text,
        'uuid, timestamp with time zone, timestamp with time zone, text, text'::text
      ),
      (
        'visible_workspace_insights_usage_events'::text,
        'p_workspace_id uuid, p_since timestamp with time zone, p_until timestamp with time zone'::text,
        'uuid, timestamp with time zone, timestamp with time zone'::text
      ),
      (
        'visible_workspace_insights_usage_events'::text,
        'p_workspace_id uuid, p_since timestamp with time zone, p_until timestamp with time zone, p_event_types text[]'::text,
        'uuid, timestamp with time zone, timestamp with time zone, text[]'::text
      )
    ) target_row(function_name, identity_arguments, call_arguments)
  LOOP
    FOR role_name IN
      SELECT grantee_role.rolname
      FROM pg_catalog.pg_proc procedure
      INNER JOIN pg_catalog.pg_namespace namespace
        ON namespace.oid = procedure.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        coalesce(
          procedure.proacl,
          pg_catalog.acldefault('f', procedure.proowner)
        )
      ) privilege
      INNER JOIN pg_catalog.pg_roles grantee_role
        ON grantee_role.oid = privilege.grantee
      WHERE namespace.nspname = 'opengeni_private'
        AND procedure.proname = target.function_name
        AND pg_catalog.pg_get_function_identity_arguments(procedure.oid) =
          target.identity_arguments
        AND privilege.grantee <> 0
        AND privilege.grantee <> procedure.proowner
      GROUP BY grantee_role.rolname
      ORDER BY grantee_role.rolname COLLATE "C"
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION opengeni_private.%I(%s) FROM %I',
        target.function_name,
        target.call_arguments,
        role_name
      );
    END LOOP;
  END LOOP;
END
$insights_fact_read_function_acl_reset$;

DO $insights_fact_read_function_grants$
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
      'REVOKE ALL ON TABLE '
        || 'opengeni_private.insights_fact_read_runtime_capabilities FROM %I',
      role_name
    );
    EXECUTE pg_catalog.format(
      'GRANT USAGE ON SCHEMA opengeni_private TO %I',
      role_name
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION '
        || 'opengeni_private.visible_workspace_insights_model_call_facts('
        || 'uuid, timestamp with time zone, timestamp with time zone), '
        || 'opengeni_private.visible_workspace_insights_model_call_facts('
        || 'uuid, timestamp with time zone, timestamp with time zone, text, text), '
        || 'opengeni_private.visible_workspace_insights_usage_events('
        || 'uuid, timestamp with time zone, timestamp with time zone), '
        || 'opengeni_private.visible_workspace_insights_usage_events('
        || 'uuid, timestamp with time zone, timestamp with time zone, text[]) TO %I',
      role_name
    );
  END LOOP;
END
$insights_fact_read_function_grants$;

RESET statement_timeout;
RESET lock_timeout;
