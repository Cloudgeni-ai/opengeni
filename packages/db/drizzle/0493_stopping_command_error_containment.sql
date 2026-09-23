-- deployment-mode: rolling
-- Inventory explicit stop requests whose provider observer repeatedly fails.
-- This is not exit proof: exact workspace enrollment still requires physical
-- owner quiescence, idle grace, no other holders/admissions and a checkpoint
-- before provider termination. Ordinary running commands remain excluded.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $install$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.list_unobservable_command_drain_candidates(p_limit integer)
    RETURNS TABLE(account_id uuid, workspace_id uuid, sandbox_group_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE inventory_id uuid;
    BEGIN
      IF p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'invalid drain batch'; END IF;
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      RETURN QUERY SELECT lease.account_id, lease.workspace_id, lease.sandbox_group_id
      FROM %1$I.sandbox_leases lease
      WHERE lease.backend = 'modal' AND lease.liveness IN ('warm', 'draining')
        AND (lease.unobservable_command_drain_ids IS NOT NULL OR EXISTS (
          SELECT 1 FROM %1$I.sandbox_retained_processes process
          WHERE process.lease_id = lease.id AND process.state = 'active'
            AND (
              process.last_reconcile_outcome IN (
                'process_observation_unavailable', 'quarantined_process_observation_unavailable',
                'provider_binding_missing', 'quarantined_provider_binding_missing',
                'provider_binding_mismatch', 'quarantined_provider_binding_mismatch'
              )
              OR (
                process.last_reconcile_outcome = 'provider_error'
                AND process.reconcile_attempts >= 5
                AND EXISTS (
                  SELECT 1 FROM %1$I.session_background_commands command
                  WHERE command.retained_process_id = process.id
                    AND command.workspace_id = process.workspace_id
                    AND command.session_id = process.session_id
                    AND command.provider = 'managed' AND command.state = 'stopping'
                    AND command.cancel_requested_at IS NOT NULL
                )
              )
            )
        ))
      ORDER BY lease.unobservable_command_checked_at NULLS FIRST, lease.id LIMIT p_limit;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END $body$;
  $definition$, target_schema);
  REVOKE ALL ON FUNCTION opengeni_private.list_unobservable_command_drain_candidates(integer) FROM PUBLIC;
END $install$;

RESET statement_timeout;
RESET lock_timeout;