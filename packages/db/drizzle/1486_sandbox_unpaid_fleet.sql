-- deployment-mode: rolling
-- Fleet-wide bounds on unpaid sandbox compute (docs/deployment.md, "Unpaid
-- fleet limits"). The per-organization and per-person plan limits bound one
-- organization or person; many fresh accounts could still add up to an
-- unbounded fleet. Admission now stamps each new box it elects for an unpaid
-- organization (unpaid tier, no bought credit, no paid subscription) and
-- counts those boxes across every organization.
--
-- 1. sandbox_leases.compute_unpaid: set by admission on every election (true
--    for an unpaid organization, false otherwise). Null on rows no release
--    has elected since, which never count.
-- 2. opengeni_private.sandbox_unpaid_fleet_v1(p_exclude_lease, p_with_box_seconds)
--    returns two numbers and nothing else: the unpaid boxes starting or warm
--    (leaving out the lease being admitted), and, when asked for, the metered
--    sandbox.warm_seconds since 00:00 UTC of every organization with an
--    unpaid box live or elected today. Sandbox leases are FORCE RLS, so it
--    opens the existing owner inventory read for its own transaction, as
--    list_live_modal_sandbox_leases does, and reads each organization's
--    usage under that organization's own RLS context, restoring the caller's.
--
-- As 0937, 0978, 1060, 1404 and 1475 explain, the previous release rejects a
-- runtime EXECUTE grant on a definer it doesn't know, so this migration grants
-- nothing. Until a later migration grants it, the runtime keeps the unpaid
-- fleet running cap and box-time budget inactive; fleet pressure and the
-- young-organization limit need no new routine.
--
-- Rolling: one nullable column with no default and no backfill, which the
-- previous release never reads or writes, and one read-only definer it never
-- calls.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE sandbox_leases
  ADD COLUMN compute_unpaid boolean;

COMMENT ON COLUMN sandbox_leases.compute_unpaid IS
  'Admission elected this box for an unpaid organization; it counts toward the unpaid fleet limits.';

DO $sandbox_unpaid_fleet$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.sandbox_unpaid_fleet_v1(
      p_exclude_lease uuid, p_with_box_seconds boolean)
    RETURNS TABLE(running_boxes integer, box_seconds_today bigint)
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      opened integer;
      running integer := 0;
      seconds bigint;
      part bigint;
      day_start timestamptz :=
        pg_catalog.date_trunc('day', pg_catalog.now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
      unpaid_accounts uuid[] := '{}';
      unpaid_account uuid;
      prior_account text;
      prior_workspace text;
    BEGIN
      INSERT INTO opengeni_private.modal_inventory_read_capabilities (
        backend_pid, transaction_id, data_schema
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), %1$L)
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS opened = ROW_COUNT;

      SELECT pg_catalog.count(*)::integer INTO running
      FROM sandbox_leases lease
      WHERE lease.liveness IN ('warming', 'warm')
        AND lease.compute_unpaid
        AND lease.backend <> 'selfhosted'
        AND lease.id IS DISTINCT FROM p_exclude_lease;

      IF p_with_box_seconds THEN
        SELECT coalesce(pg_catalog.array_agg(DISTINCT lease.account_id), '{}')
          INTO unpaid_accounts
        FROM sandbox_leases lease
        WHERE lease.compute_unpaid
          AND lease.backend <> 'selfhosted'
          AND (lease.liveness IN ('warming', 'warm', 'draining') OR lease.updated_at >= day_start);
      END IF;

      IF opened = 1 THEN
        DELETE FROM opengeni_private.modal_inventory_read_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.data_schema = %1$L;
      END IF;

      IF p_with_box_seconds THEN
        seconds := 0;
        prior_account := pg_catalog.current_setting('opengeni.account_id', true);
        prior_workspace := pg_catalog.current_setting('opengeni.workspace_id', true);
        FOREACH unpaid_account IN ARRAY unpaid_accounts LOOP
          PERFORM pg_catalog.set_config('opengeni.account_id', unpaid_account::text, true);
          PERFORM pg_catalog.set_config('opengeni.workspace_id', '', true);
          SELECT coalesce(pg_catalog.sum(usage.quantity), 0)::bigint INTO part
          FROM usage_events usage
          WHERE usage.account_id = unpaid_account
            AND usage.event_type = 'sandbox.warm_seconds'
            AND usage.occurred_at >= day_start;
          seconds := seconds + part;
        END LOOP;
        PERFORM pg_catalog.set_config('opengeni.account_id', coalesce(prior_account, ''), true);
        PERFORM pg_catalog.set_config('opengeni.workspace_id', coalesce(prior_workspace, ''), true);
      END IF;

      RETURN QUERY SELECT running, seconds;
    END
    $body$
  $definition$, data_schema);
END
$sandbox_unpaid_fleet$;

REVOKE ALL ON FUNCTION opengeni_private.sandbox_unpaid_fleet_v1(uuid, boolean) FROM PUBLIC;
