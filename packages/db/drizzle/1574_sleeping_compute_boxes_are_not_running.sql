-- deployment-mode: rolling
-- A sleeping compute sandbox is not a running box.
--
-- Opengeni never drains a compute lease for being idle (migration 0859,
-- docs/compute-backend.md): the sandbox sleeps on its host and keeps its
-- memory and disk, and its lease stays 'warm' with compute_asleep_since
-- stamped by the agent gateway. Every box count that bounds new boxes read
-- only liveness, so an organization's sleeping chats kept filling its
-- runningBoxesPerOrganization budget for weeks, and every new chat parked as
-- organization_sandbox_capacity although nothing ran. The unpaid fleet cap and
-- fleet pressure counted them the same way.
--
-- This redefines the three counting definers with the same signatures,
-- security, search path and grants (CREATE OR REPLACE keeps the ACL), so the
-- running release reads the corrected numbers at once. Each one now leaves out
-- a compute lease whose sandbox is asleep and that no turn holds:
--
--   organization_warm_sandbox_counts_v1  every count (1475)
--   sandbox_unpaid_fleet_v1              the running count (1486); the day's
--                                        box seconds are metered usage and
--                                        are unchanged
--   sandbox_fleet_warm_boxes_v1          the warm count fleet pressure reads
--                                        (1492)
--
-- The runtime admits waking such a box like a new one (acquireLease), so the
-- limits still bound how many boxes run. A box a turn holds counts even while
-- it naps, so a turn that wakes a sleeping box counts from its own admitting
-- transaction (it adds the turn holder under the organization lock), and the
-- turn's next tool call can wake it again without a check. A woken box no turn
-- holds counts once the gateway records it awake; until then a concurrent
-- non-turn wake (terminal, viewer, Browser/ComputerSession) of another box does
-- not see it, a window of seconds. A draining compute lease asleep with no
-- turn is a sleeping box being ended, not a running one, so the running count
-- leaves it out too.
--
-- Rolling: read-only definers keep their signatures and grants; the previous
-- release calls them unchanged and only gets lower counts.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

DO $sleeping_compute_boxes$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.organization_warm_sandbox_counts_v1(
      p_account uuid, p_subject text, p_exclude_lease uuid)
    RETURNS TABLE(viewer_only_boxes integer, subject_viewer_only_boxes integer,
      running_boxes integer)
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      prior_workspace text;
      member record;
      viewer_only integer := 0;
      subject_viewer_only integer := 0;
      running integer := 0;
      part_viewer_only integer;
      part_subject integer;
      part_running integer;
    BEGIN
      IF p_account IS NULL OR p_account IS DISTINCT FROM opengeni_private.current_account_id() THEN
        RAISE EXCEPTION 'organization sandbox count scope mismatch' USING ERRCODE = '42501';
      END IF;
      prior_workspace := pg_catalog.current_setting('opengeni.workspace_id', true);
      FOR member IN SELECT w.id FROM workspaces w WHERE w.account_id = p_account ORDER BY w.id LOOP
        PERFORM pg_catalog.set_config('opengeni.workspace_id', member.id::text, true);
        SELECT
          pg_catalog.count(*) FILTER (WHERE lease.liveness IN ('warming', 'warm')
            AND lease.turn_holders = 0
            AND EXISTS (SELECT 1 FROM sandbox_lease_holders h
              WHERE h.lease_id = lease.id AND h.kind = 'viewer'))::integer,
          pg_catalog.count(*) FILTER (WHERE p_subject IS NOT NULL
            AND lease.liveness IN ('warming', 'warm')
            AND lease.turn_holders = 0
            AND EXISTS (SELECT 1 FROM sandbox_lease_holders h
              WHERE h.lease_id = lease.id AND h.kind = 'viewer'
                AND h.viewer_subject_id = p_subject))::integer,
          pg_catalog.count(*) FILTER (WHERE lease.liveness IN ('warming', 'warm', 'draining')
            AND lease.backend <> 'selfhosted')::integer
        INTO part_viewer_only, part_subject, part_running
        FROM sandbox_leases lease
        WHERE lease.account_id = p_account AND lease.workspace_id = member.id
          AND lease.id IS DISTINCT FROM p_exclude_lease
          -- A sleeping compute sandbox no turn holds runs nothing (1574).
          AND NOT (lease.backend = 'compute' AND lease.compute_asleep_since IS NOT NULL
            AND lease.turn_holders = 0);
        viewer_only := viewer_only + part_viewer_only;
        subject_viewer_only := subject_viewer_only + part_subject;
        running := running + part_running;
      END LOOP;
      PERFORM pg_catalog.set_config('opengeni.workspace_id', coalesce(prior_workspace, ''), true);
      RETURN QUERY SELECT viewer_only, subject_viewer_only, running;
    END
    $body$
  $definition$, data_schema);

  EXECUTE pg_catalog.format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.sandbox_unpaid_fleet_v1(
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
        -- A sleeping compute sandbox no turn holds runs nothing (1574).
        AND NOT (lease.backend = 'compute' AND lease.compute_asleep_since IS NOT NULL
          AND lease.turn_holders = 0)
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

  EXECUTE pg_catalog.format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.sandbox_fleet_warm_boxes_v1()
    RETURNS integer
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      opened integer;
      warm integer := 0;
    BEGIN
      INSERT INTO opengeni_private.modal_inventory_read_capabilities (
        backend_pid, transaction_id, data_schema
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), %1$L)
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS opened = ROW_COUNT;

      SELECT pg_catalog.count(*)::integer INTO warm
      FROM sandbox_leases lease
      WHERE lease.liveness IN ('warming', 'warm')
        AND lease.backend <> 'selfhosted'
        -- A sleeping compute sandbox no turn holds runs nothing (1574).
        AND NOT (lease.backend = 'compute' AND lease.compute_asleep_since IS NOT NULL
          AND lease.turn_holders = 0);

      IF opened = 1 THEN
        DELETE FROM opengeni_private.modal_inventory_read_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.data_schema = %1$L;
      END IF;

      RETURN warm;
    END
    $body$
  $definition$, data_schema);
END
$sleeping_compute_boxes$;
