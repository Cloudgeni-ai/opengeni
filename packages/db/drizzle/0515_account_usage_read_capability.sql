-- deployment-mode: rolling
-- Account-scoped usage-cap admission (maxMonthlyCostMicrosPerAccount and the
-- reservation ledger) needs an exact account-wide sum over usage_events,
-- including session-bound facts. No plain RLS context can read them: the
-- session_visibility_isolation RESTRICTIVE policy resolves every
-- session-bound row through session_reference_visible -> sessions, and
-- sessions' strict workspace isolation hides them from an account-only
-- scope, so a direct SELECT silently undercounts every model.cost row.
--
-- This SECURITY DEFINER aggregate follows the organization_usage_summary
-- contract: it verifies the caller's exact account-only context, mints the
-- short-lived owner read capability, computes one bounded sum, and revokes
-- the capability. It never returns raw facts and changes no write, tenant,
-- or session policy.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $migration$
DECLARE
  data_schema text := current_schema();
  role_name text;
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.account_usage_quantity(
      p_account_id uuid,
      p_event_type text,
      p_since timestamp with time zone
    ) RETURNS numeric
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $fn$
    DECLARE
      context_account_id uuid;
      minted boolean := false;
      total numeric;
    BEGIN
      PERFORM opengeni_private.session_variable_set_attachments_protocol_v1_active();
      BEGIN
        context_account_id := nullif(
          pg_catalog.current_setting('opengeni.account_id', true), '')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'Account usage RLS context is malformed'
          USING ERRCODE = '42501';
      END;
      IF context_account_id IS NULL
        OR context_account_id IS DISTINCT FROM p_account_id
        OR nullif(pg_catalog.current_setting('opengeni.workspace_id', true), '')
          IS NOT NULL
      THEN
        RAISE EXCEPTION 'Account usage requires the exact account-only context'
          USING ERRCODE = '42501';
      END IF;
      IF p_event_type IS NULL OR octet_length(p_event_type) = 0
        OR p_since IS NULL
        OR (p_since <> '-infinity'::timestamp with time zone
          AND NOT isfinite(p_since))
      THEN
        RAISE EXCEPTION 'Account usage event type or window is invalid'
          USING ERRCODE = '22023';
      END IF;

      -- Same capability the organization_usage_summary read path mints: a
      -- same-backend, same-transaction row that lifts the restrictive
      -- fact-visibility policy for the table owner only. A pre-existing row
      -- from an enclosing mint is reused, never deleted early; a conflicting
      -- one refuses rather than silently undercounting.
      INSERT INTO opengeni_private.organization_usage_read_capabilities
        (backend_pid, transaction_id, account_id, subject_id,
         initiating_human_subject_id)
      VALUES (
        pg_catalog.pg_backend_pid(),
        pg_catalog.pg_current_xact_id(),
        context_account_id,
        nullif(pg_catalog.current_setting('opengeni.subject_id', true), ''),
        nullif(pg_catalog.current_setting(
          'opengeni.initiating_human_subject_id', true), '')
      )
      ON CONFLICT (backend_pid, transaction_id) DO NOTHING;
      minted := FOUND;
      IF NOT minted AND NOT EXISTS (
        SELECT 1
        FROM opengeni_private.organization_usage_read_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND account_id = context_account_id
      ) THEN
        RAISE EXCEPTION 'Account usage capability context mismatch'
          USING ERRCODE = '42501';
      END IF;

      BEGIN
        SELECT coalesce(sum(usage_row.quantity), 0) INTO total
        FROM %1$I.usage_events usage_row
        WHERE usage_row.account_id = p_account_id
          AND usage_row.event_type = p_event_type
          AND (p_since = '-infinity'::timestamp with time zone
            OR usage_row.occurred_at >= p_since);
        IF minted THEN
          DELETE FROM opengeni_private.organization_usage_read_capabilities
          WHERE backend_pid = pg_catalog.pg_backend_pid()
            AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
        END IF;
        RETURN total;
      EXCEPTION WHEN OTHERS THEN
        IF minted THEN
          DELETE FROM opengeni_private.organization_usage_read_capabilities
          WHERE backend_pid = pg_catalog.pg_backend_pid()
            AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
        END IF;
        RAISE;
      END;
    END
    $fn$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.account_open_usage_reservations(
      p_account_id uuid,
      p_event_type text,
      p_since timestamp with time zone,
      p_hold_since timestamp with time zone
    ) RETURNS numeric
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $fn$
    DECLARE
      context_account_id uuid;
      minted boolean := false;
      total numeric;
    BEGIN
      PERFORM opengeni_private.session_variable_set_attachments_protocol_v1_active();
      BEGIN
        context_account_id := nullif(
          pg_catalog.current_setting('opengeni.account_id', true), '')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'Account usage RLS context is malformed'
          USING ERRCODE = '42501';
      END;
      IF context_account_id IS NULL
        OR context_account_id IS DISTINCT FROM p_account_id
        OR nullif(pg_catalog.current_setting('opengeni.workspace_id', true), '')
          IS NOT NULL
      THEN
        RAISE EXCEPTION 'Account usage requires the exact account-only context'
          USING ERRCODE = '42501';
      END IF;
      IF p_event_type IS NULL OR octet_length(p_event_type) = 0
        OR p_since IS NULL OR p_hold_since IS NULL
        OR (p_since <> '-infinity'::timestamp with time zone
          AND NOT isfinite(p_since))
        OR (p_hold_since <> '-infinity'::timestamp with time zone
          AND NOT isfinite(p_hold_since))
      THEN
        RAISE EXCEPTION 'Account usage event type or window is invalid'
          USING ERRCODE = '22023';
      END IF;

      INSERT INTO opengeni_private.organization_usage_read_capabilities
        (backend_pid, transaction_id, account_id, subject_id,
         initiating_human_subject_id)
      VALUES (
        pg_catalog.pg_backend_pid(),
        pg_catalog.pg_current_xact_id(),
        context_account_id,
        nullif(pg_catalog.current_setting('opengeni.subject_id', true), ''),
        nullif(pg_catalog.current_setting(
          'opengeni.initiating_human_subject_id', true), '')
      )
      ON CONFLICT (backend_pid, transaction_id) DO NOTHING;
      minted := FOUND;
      IF NOT minted AND NOT EXISTS (
        SELECT 1
        FROM opengeni_private.organization_usage_read_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND account_id = context_account_id
      ) THEN
        RAISE EXCEPTION 'Account usage capability context mismatch'
          USING ERRCODE = '42501';
      END IF;

      -- Per-reservation netting: each hold/release group shares one
      -- source_resource_id. A group counts only when its positive hold row is
      -- newer than the TTL cutoff AND still nets positive after its own
      -- releases. An expired hold's release must never net against another
      -- call's live hold.
      BEGIN
        SELECT coalesce(sum(
          CASE WHEN g.hold_at >= p_hold_since THEN greatest(g.net, 0) ELSE 0 END
        ), 0) INTO total
        FROM (
          SELECT sum(usage_row.quantity) AS net,
            max(usage_row.occurred_at)
              FILTER (WHERE usage_row.quantity > 0) AS hold_at
          FROM %1$I.usage_events usage_row
          WHERE usage_row.account_id = p_account_id
            AND usage_row.event_type = p_event_type
            AND usage_row.occurred_at >= p_since
          GROUP BY usage_row.source_resource_id
        ) g;
        IF minted THEN
          DELETE FROM opengeni_private.organization_usage_read_capabilities
          WHERE backend_pid = pg_catalog.pg_backend_pid()
            AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
        END IF;
        RETURN total;
      EXCEPTION WHEN OTHERS THEN
        IF minted THEN
          DELETE FROM opengeni_private.organization_usage_read_capabilities
          WHERE backend_pid = pg_catalog.pg_backend_pid()
            AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
        END IF;
        RAISE;
      END;
    END
    $fn$;
  $ddl$, data_schema);

  EXECUTE 'REVOKE ALL ON FUNCTION opengeni_private.account_usage_quantity(uuid, text, timestamp with time zone) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION opengeni_private.account_open_usage_reservations(uuid, text, timestamp with time zone, timestamp with time zone) FROM PUBLIC';
  FOR role_name IN
    SELECT r.rolname
    FROM jsonb_array_elements_text(
      current_setting('opengeni.migration_application_roles')::jsonb
    ) configured(value)
    JOIN pg_roles r ON r.rolname = configured.value
    WHERE has_table_privilege(
      r.rolname, format('%I.usage_events', data_schema), 'SELECT')
  LOOP
    EXECUTE 'GRANT USAGE ON SCHEMA opengeni_private TO ' || quote_ident(role_name);
    EXECUTE 'GRANT EXECUTE ON FUNCTION opengeni_private.account_usage_quantity(uuid, text, timestamp with time zone) TO ' || quote_ident(role_name);
    EXECUTE 'GRANT EXECUTE ON FUNCTION opengeni_private.account_open_usage_reservations(uuid, text, timestamp with time zone, timestamp with time zone) TO ' || quote_ident(role_name);
  END LOOP;
END
$migration$;
