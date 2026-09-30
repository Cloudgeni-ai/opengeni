-- deployment-mode: rolling
-- One idle rule contains legacy retained commands. When every session of a
-- Modal sandbox group has been idle for the configured window, the reaper
-- enrolls the commands that alone keep the box warm into the existing
-- capture -> terminate -> settle drain. Old enrollment code keeps its narrower
-- per-process predicates and simply declines the extra candidates.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- Durable holder-set activity. Every writer generation recounts these columns
-- when it acquires or releases any holder, so the database, not application
-- code, stamps the change. The stable default is evaluated once: existing rows
-- start their idle clock at migration time instead of being contained at once.
ALTER TABLE sandbox_leases
  ADD COLUMN holders_changed_at timestamptz NOT NULL DEFAULT now();

CREATE FUNCTION opengeni_private.stamp_sandbox_lease_holders_changed()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.holders_changed_at := clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.stamp_sandbox_lease_holders_changed() FROM PUBLIC;
CREATE TRIGGER sandbox_lease_holders_changed
  BEFORE UPDATE OF refcount, turn_holders, viewer_holders ON sandbox_leases
  FOR EACH ROW WHEN (
    OLD.refcount IS DISTINCT FROM NEW.refcount
    OR OLD.turn_holders IS DISTINCT FROM NEW.turn_holders
    OR OLD.viewer_holders IS DISTINCT FROM NEW.viewer_holders
  )
  EXECUTE FUNCTION opengeni_private.stamp_sandbox_lease_holders_changed();

-- Inventory only, independent of command health. Exact workspace enrollment
-- still takes the control fence and process/admission/lease locks, then
-- requires whole-group idleness (or the provider-deadline grace) before it
-- changes lifecycle state.
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
        AND (lease.unobservable_command_drain_ids IS NOT NULL OR (
          lease.archive_capture_id IS NULL
          AND (lease.reaper_hold_until IS NULL OR lease.reaper_hold_until <= now())
          AND EXISTS (
            SELECT 1 FROM %1$I.sandbox_retained_processes process
            WHERE process.lease_id = lease.id AND process.state = 'active'
          )
          AND NOT EXISTS (
            SELECT 1 FROM %1$I.sandbox_retained_processes process
            WHERE process.lease_id = lease.id AND process.state = 'active'
              AND coalesce(process.provider_command, '{}'::jsonb) ? 'supervision'
          )
          AND NOT EXISTS (
            SELECT 1 FROM %1$I.sandbox_lease_holders holder
            WHERE holder.lease_id = lease.id AND holder.kind <> 'process'
          )
        ))
      ORDER BY
        CASE WHEN lease.rotation_reason = 'provider_deadline'
          AND lease.rotation_requested_at IS NOT NULL THEN 0 ELSE 1 END,
        CASE WHEN lease.rotation_reason = 'provider_deadline'
          AND lease.rotation_requested_at IS NOT NULL
          THEN lease.provider_deadline_at END NULLS LAST,
        lease.unobservable_command_checked_at NULLS FIRST,
        lease.id LIMIT p_limit;
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
