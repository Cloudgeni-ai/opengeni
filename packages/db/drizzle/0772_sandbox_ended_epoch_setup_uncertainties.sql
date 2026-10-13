-- deployment-mode: rolling
-- Sandbox setup whose start outcome is unknown, on a Modal box that is gone.
--
-- When a setup command's start outcome is unknown, its turn waits for physical
-- proof that nothing it may have started is still running. Until now the only
-- accepted proof was the exit of a retained process recorded for it. A start
-- that failed before any process was recorded leaves nothing to exit, so once
-- its box was stopped the turn stayed recovering forever.
--
-- A terminated observation of the exact historical sandbox is the same
-- physical proof: nothing can run on a terminated box. This function lists
-- such turns with the single exact provider tuple (lease, epoch, Modal box)
-- every setup request of the uncertain attempt ran on, once the lease has moved
-- to a later epoch and another (or no) box. Lease succession alone is not
-- proof: the reaper inspects the exact historical sandbox and reconciles only
-- on a terminated observation, in its own workspace-scoped transaction that
-- revalidates every condition. Nothing is replayed; setup reruns its
-- idempotent preparation. Directly paused sessions are not listed. Inventory
-- only, in random order.
--
-- The reaper's existing ended-epoch maintenance check is extended so a
-- deployment with such a turn starts the maintenance pass; it reads the
-- partial index from 0771 and stays false when there is nothing to do.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $install$
DECLARE target_schema text := current_schema(); role_name text;
BEGIN
  EXECUTE format($definition$
    CREATE FUNCTION opengeni_private.list_sandbox_ended_epoch_setup_uncertainties(p_limit integer)
    RETURNS TABLE(account_id uuid, workspace_id uuid, session_id uuid, turn_id uuid,
      attempt_id uuid, lease_id uuid, sandbox_group_id uuid, lease_epoch bigint,
      provider_backend text, provider_instance_id text)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
    DECLARE inventory_id uuid;
    BEGIN
      IF p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION 'invalid ended-epoch setup batch';
      END IF;
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      RETURN QUERY
      WITH waiting AS (
        SELECT turn.account_id, turn.workspace_id, turn.session_id, turn.id AS turn_id,
          attempt.id AS attempt_id
        FROM %1$I.session_turns turn
        JOIN %1$I.sessions session
          ON session.workspace_id = turn.workspace_id
         AND session.id = turn.session_id
         AND session.active_turn_id = turn.id
        JOIN %1$I.session_turn_attempts attempt
          ON attempt.workspace_id = turn.workspace_id
         AND attempt.session_id = turn.session_id
         AND attempt.turn_id = turn.id
         AND attempt.id::text = turn.metadata #>> '{sandboxSetupOutcomeUnknown,attemptId}'
        WHERE turn.status = 'recovering'
          AND turn.metadata ? 'sandboxSetupOutcomeUnknown'
          AND turn.metadata -> 'sandboxSetupOutcomeUnknown' @> jsonb_build_object(
            'version', 1, 'turnId', turn.id::text,
            'reason', 'sandbox_command_start_outcome_unknown')
          AND NOT turn.metadata ? 'sandboxSetupRecoveryExhausted'
          AND turn.active_attempt_id IS NULL
          AND session.status = 'recovering'
          AND session.direct_control_state = 'active'
          AND attempt.state = 'closed'
          AND attempt.quiesced_at IS NOT NULL
          AND attempt.execution_generation = turn.execution_generation
          AND NOT EXISTS (
            SELECT 1 FROM %1$I.sandbox_retained_processes process
            WHERE process.workspace_id = turn.workspace_id
              AND process.session_id = turn.session_id
              AND process.owner_attempt_id = attempt.id
              AND process.state = 'active'
          )
      ), boxes AS (
        SELECT DISTINCT waiting.account_id, waiting.workspace_id, waiting.session_id,
          waiting.turn_id, waiting.attempt_id, admission.lease_id, admission.sandbox_group_id,
          admission.lease_epoch, admission.provider_backend, admission.provider_instance_id
        FROM waiting
        JOIN %1$I.sandbox_workspace_mutation_admissions admission
          ON admission.workspace_id = waiting.workspace_id
         AND admission.session_id = waiting.session_id
         AND admission.attempt_id = waiting.attempt_id
         AND admission.turn_id = waiting.turn_id
         AND admission.actor_kind = 'turn'
         AND admission.actor_id = waiting.attempt_id
         AND admission.operation IN ('lazyOwnedSandboxSetup', 'eagerOwnedSandboxSetup')
         AND admission.route_kind = 'home'
      ), single_box AS (
        SELECT box.* FROM boxes box
        WHERE NOT EXISTS (
          SELECT 1 FROM boxes other
          WHERE other.turn_id = box.turn_id
            AND (other.lease_id, other.lease_epoch, other.provider_backend,
                 other.provider_instance_id)
              IS DISTINCT FROM (box.lease_id, box.lease_epoch, box.provider_backend,
                 box.provider_instance_id)
        )
      )
      SELECT box.account_id, box.workspace_id, box.session_id, box.turn_id, box.attempt_id,
        box.lease_id, box.sandbox_group_id, box.lease_epoch::bigint, box.provider_backend,
        box.provider_instance_id
      FROM single_box box
      JOIN %1$I.sandbox_leases lease
        ON lease.id = box.lease_id
       AND lease.account_id = box.account_id
       AND lease.workspace_id = box.workspace_id
       AND lease.sandbox_group_id = box.sandbox_group_id
      WHERE box.provider_backend = 'modal'
        AND box.provider_instance_id IS NOT NULL
        AND lease.backend = 'modal'
        AND lease.lease_epoch > box.lease_epoch
        AND lease.instance_id IS DISTINCT FROM box.provider_instance_id
      ORDER BY random()
      LIMIT p_limit;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END $body$;
  $definition$, target_schema);
  REVOKE ALL ON FUNCTION opengeni_private.list_sandbox_ended_epoch_setup_uncertainties(integer) FROM PUBLIC;
  FOR role_name IN SELECT rolname FROM pg_roles
    WHERE rolname <> current_user AND has_function_privilege(oid,
      'opengeni_private.reap_sandbox_leases(bigint,bigint,bigint,bigint)', 'EXECUTE')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.list_sandbox_ended_epoch_setup_uncertainties(integer) TO %I', role_name);
  END LOOP;

  -- Still a superset of both inventories it previews: any open Modal home
  -- request, or any active recovering turn of a directly unpaused session
  -- still waiting on unknown setup (0771's partial index). CREATE OR REPLACE
  -- keeps its owner and grants.
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.sandbox_ended_epoch_blockers_due_v1()
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
      SELECT EXISTS (
        SELECT 1 FROM %1$I.sandbox_workspace_mutation_admissions admission
        WHERE admission.settled_at IS NULL AND admission.route_kind = 'home'
          AND admission.provider_backend = 'modal'
      ) OR EXISTS (
        SELECT 1 FROM %1$I.session_turns turn
        JOIN %1$I.sessions session
          ON session.workspace_id = turn.workspace_id
         AND session.id = turn.session_id
         AND session.active_turn_id = turn.id
        WHERE turn.status = 'recovering'
          AND turn.metadata ? 'sandboxSetupOutcomeUnknown'
          AND session.direct_control_state = 'active'
      )
    $body$;
  $definition$, target_schema);
END $install$;

RESET statement_timeout;
RESET lock_timeout;
