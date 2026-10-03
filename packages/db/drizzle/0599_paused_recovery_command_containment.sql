-- deployment-mode: rolling
-- Paused recovery records do not prove that a sandbox is in use. Let the
-- inventory include recovering turns; exact enrollment resolves effective pause
-- under its workspace control fence and still requires physical quiescence.
-- Older workers retain their narrower enrollment predicate during rollout.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $install$
DECLARE target_schema text := current_schema(); role_name text;
BEGIN
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.list_command_containment_candidates(
      p_limit integer, p_idle_ms bigint)
    RETURNS TABLE(account_id uuid, workspace_id uuid, sandbox_group_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE inventory_id uuid; idle_before timestamptz;
    BEGIN
      IF p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'invalid drain batch'; END IF;
      IF p_idle_ms IS NOT NULL AND p_idle_ms < 1 THEN RAISE EXCEPTION 'invalid idle window'; END IF;
      idle_before := now() - p_idle_ms * interval '1 millisecond';
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
          AND (lease.rotation_requested_at IS NOT NULL OR (
            idle_before IS NOT NULL
            AND lease.holders_changed_at < idle_before
            AND NOT EXISTS (
              SELECT 1 FROM %1$I.sandbox_workspace_mutation_admissions admission
              WHERE admission.lease_id = lease.id AND admission.lease_epoch = lease.lease_epoch
                AND coalesce(admission.settled_at, admission.admitted_at) >= idle_before
            )
            AND NOT EXISTS (
              SELECT 1 FROM %1$I.sessions member
              WHERE member.workspace_id = lease.workspace_id
                AND (member.sandbox_group_id = lease.sandbox_group_id OR EXISTS (
                  SELECT 1 FROM %1$I.sandbox_retained_processes owned
                  WHERE owned.lease_id = lease.id AND owned.state = 'active'
                    AND owned.session_id = member.id))
                AND (
                  -- An input wait holds until its deadline; idleness counts
                  -- from the wait's end.
                  member.input_wait_until >= idle_before
                  -- Unclaimed turn-starting machine input, on the idle
                  -- clock from its creation (a paused session may never
                  -- deliver it).
                  OR EXISTS (
                    SELECT 1 FROM %1$I.session_system_updates pending_update
                    WHERE pending_update.workspace_id = member.workspace_id
                      AND pending_update.session_id = member.id
                      AND pending_update.state = 'pending'
                      AND pending_update.created_at >= idle_before
                      AND (pending_update.kind IN ('scheduled_occurrence', 'goal_continuation',
                          'agent_message', 'agent_steer_instruction', 'session_wait_timeout',
                          'media_generation_result')
                        OR (pending_update.kind IN ('child_terminal_result', 'child_requires_action')
                          AND EXISTS (
                            SELECT 1 FROM %1$I.session_goals goal
                            WHERE goal.workspace_id = member.workspace_id
                              AND goal.session_id = member.id AND goal.status = 'active')))
                  )
                  OR
                  EXISTS (
                    SELECT 1 FROM %1$I.session_turns turn
                    WHERE turn.workspace_id = member.workspace_id AND turn.session_id = member.id
                      AND turn.status IN ('queued', 'running', 'requires_action',
                        'waiting_capacity')
                  )
                  OR EXISTS (
                    SELECT 1 FROM %1$I.session_turns turn
                    WHERE turn.workspace_id = member.workspace_id AND turn.session_id = member.id
                      AND turn.finished_at >= idle_before
                  )
                  OR EXISTS (
                    SELECT 1 FROM %1$I.session_turn_attempts attempt
                    WHERE attempt.workspace_id = member.workspace_id
                      AND attempt.session_id = member.id
                      AND (attempt.state <> 'closed' OR coalesce(attempt.quiesced_at,
                        attempt.closed_at, attempt.updated_at) >= idle_before)
                  )
                )
            )
          ))
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
  REVOKE ALL ON FUNCTION opengeni_private.list_command_containment_candidates(integer, bigint) FROM PUBLIC;
  FOR role_name IN SELECT rolname FROM pg_roles
    WHERE rolname <> current_user AND has_function_privilege(oid,
      'opengeni_private.reap_sandbox_leases(bigint,bigint,bigint,bigint)', 'EXECUTE')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.list_command_containment_candidates(integer, bigint) TO %I', role_name);
  END LOOP;
END $install$;

RESET statement_timeout;
RESET lock_timeout;
