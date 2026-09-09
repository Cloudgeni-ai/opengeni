-- deployment-mode: rolling
-- Enrollment is lifecycle intent, not process-exit proof. Keep holders until
-- the existing checkpoint/terminate path confirms provider termination.
ALTER TABLE sandbox_leases ADD COLUMN unobservable_command_drain_ids uuid[];
ALTER TABLE sandbox_leases ADD COLUMN unobservable_command_checked_at timestamptz;

CREATE FUNCTION opengeni_private.clear_unobservable_command_drain()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.lease_epoch IS DISTINCT FROM OLD.lease_epoch
    OR NEW.instance_id IS DISTINCT FROM OLD.instance_id
    OR NEW.liveness = 'cold' THEN
    NEW.unobservable_command_drain_ids := NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.clear_unobservable_command_drain() FROM PUBLIC;
CREATE TRIGGER sandbox_clear_unobservable_command_drain
  BEFORE UPDATE ON sandbox_leases FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.clear_unobservable_command_drain();

-- Inventory only. Per-workspace enrollment takes the existing control fence
-- and exact process/admission/lease locks before changing lifecycle state.
DO $install$
DECLARE target_schema text := current_schema(); role_name text;
BEGIN
  EXECUTE format($definition$
    CREATE FUNCTION opengeni_private.list_unobservable_command_drain_candidates(p_limit integer)
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
            AND process.last_reconcile_outcome IN (
              'process_observation_unavailable', 'quarantined_process_observation_unavailable'
              , 'provider_binding_missing', 'quarantined_provider_binding_missing',
              'provider_binding_mismatch', 'quarantined_provider_binding_mismatch'
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
  FOR role_name IN SELECT rolname FROM pg_roles
    WHERE rolname <> current_user AND has_function_privilege(oid,
      'opengeni_private.reap_sandbox_leases(bigint,bigint,bigint,bigint)', 'EXECUTE')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.list_unobservable_command_drain_candidates(integer) TO %I', role_name);
  END LOOP;
END $install$;
