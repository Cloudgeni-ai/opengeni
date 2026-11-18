-- deployment-mode: rolling
-- The warm count fleet pressure reads (docs/deployment.md, "Unpaid fleet
-- limits"). Pressure stands in for managed compute spend, but until now it
-- read count_sandbox_leases_by_liveness(), which counts every lease,
-- including self-hosted (Connected Machine) boxes. Those cost the deployment
-- nothing and are exempt from the fleet limits, so a deployment with many
-- Connected Machines stayed under pressure for good.
--
-- opengeni_private.sandbox_fleet_warm_boxes_v1() returns one number: the
-- boxes of a managed provider (backend other than 'selfhosted', as
-- sandbox_unpaid_fleet_v1 and organization_warm_sandbox_counts_v1 count
-- them) that are starting or warm, across every organization. Sandbox leases
-- are FORCE RLS, so like sandbox_unpaid_fleet_v1 it opens the existing owner
-- inventory read for its own transaction and closes it again.
--
-- As 0937, 0978, 1060, 1404, 1475 and 1486 explain, the previous release
-- rejects a runtime EXECUTE grant on a definer it doesn't know, so this
-- migration grants nothing. Until a later migration grants it, the runtime
-- keeps reading the count of every lease.
--
-- Rolling: one read-only definer the previous release never calls.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

DO $sandbox_fleet_warm_boxes$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.sandbox_fleet_warm_boxes_v1()
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
        AND lease.backend <> 'selfhosted';

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
$sandbox_fleet_warm_boxes$;

REVOKE ALL ON FUNCTION opengeni_private.sandbox_fleet_warm_boxes_v1() FROM PUBLIC;
