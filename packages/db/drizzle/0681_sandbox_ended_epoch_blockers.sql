-- deployment-mode: rolling
-- Open requests left on a Modal box whose lease epoch has ended.
--
-- A request recorded on an earlier lease epoch and a different box can
-- never progress once that box is gone, yet nothing settled it after the lease
-- moved on (legacy losses before exact loss settlement, or a cold commit that
-- left it open). It pins its attempt's quiescence, and with it the session's
-- work claim, forever.
--
-- Lease succession alone is not proof that the old box is gone. The reaper
-- lists such exact provider tuples through this function, inspects the exact
-- historical Modal sandbox, and only a terminal observation lets it settle the
-- tuple in its own workspace-scoped transaction (requests rejected, never
-- replayed; owners woken). Tuples with an active retained process are left to
-- retained-process reconciliation, which settles the process, its requests and
-- its terminals from its own exact provider proof. An open PTY always belongs
-- to an active process on its exact tuple (0117), so PTYs never need listing
-- here. Other backends, Connected Machine routes and selfhosted boxes are never
-- listed. Inventory only, in random order so a box the provider cannot yet
-- prove gone never holds the head of the list.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $install$
DECLARE target_schema text := current_schema(); role_name text;
BEGIN
  EXECUTE format($definition$
    CREATE FUNCTION opengeni_private.list_sandbox_ended_epoch_blockers(p_limit integer)
    RETURNS TABLE(account_id uuid, workspace_id uuid, lease_id uuid, sandbox_group_id uuid,
      lease_epoch bigint, provider_backend text, provider_instance_id text)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
    DECLARE inventory_id uuid;
    BEGIN
      IF p_limit < 1 OR p_limit > 500 THEN RAISE EXCEPTION 'invalid ended-epoch batch'; END IF;
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      RETURN QUERY
      WITH blockers AS (
        SELECT DISTINCT admission.account_id, admission.workspace_id, admission.lease_id,
          admission.sandbox_group_id, admission.lease_epoch, admission.provider_backend,
          admission.provider_instance_id
        FROM %1$I.sandbox_workspace_mutation_admissions admission
        WHERE admission.settled_at IS NULL AND admission.route_kind = 'home'
          AND admission.provider_backend = 'modal'
      )
      SELECT blocker.account_id, blocker.workspace_id, blocker.lease_id,
        blocker.sandbox_group_id, blocker.lease_epoch::bigint, blocker.provider_backend,
        blocker.provider_instance_id
      FROM blockers blocker
      JOIN %1$I.sandbox_leases lease
        ON lease.id = blocker.lease_id
       AND lease.account_id = blocker.account_id
       AND lease.workspace_id = blocker.workspace_id
       AND lease.sandbox_group_id = blocker.sandbox_group_id
      WHERE blocker.provider_instance_id IS NOT NULL
        AND lease.backend = 'modal'
        AND lease.lease_epoch > blocker.lease_epoch
        AND lease.instance_id IS DISTINCT FROM blocker.provider_instance_id
        AND NOT EXISTS (
          SELECT 1 FROM %1$I.sandbox_retained_processes process
          WHERE process.lease_id = blocker.lease_id
            AND process.lease_epoch = blocker.lease_epoch
            AND process.provider_backend = blocker.provider_backend
            AND process.provider_instance_id = blocker.provider_instance_id
            AND process.state = 'active'
        )
      ORDER BY random()
      LIMIT p_limit;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END $body$;
  $definition$, target_schema);
  REVOKE ALL ON FUNCTION opengeni_private.list_sandbox_ended_epoch_blockers(integer) FROM PUBLIC;
  FOR role_name IN SELECT rolname FROM pg_roles
    WHERE rolname <> current_user AND has_function_privilege(oid,
      'opengeni_private.reap_sandbox_leases(bigint,bigint,bigint,bigint)', 'EXECUTE')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.list_sandbox_ended_epoch_blockers(integer) TO %I', role_name);
  END LOOP;
END $install$;

RESET statement_timeout;
RESET lock_timeout;
