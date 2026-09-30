-- deployment-mode: rolling
-- One idle rule contains legacy retained commands. When every session of a
-- Modal sandbox group has been unused for the configured window, the reaper
-- enrolls the commands that alone keep the box warm into the existing
-- capture -> terminate -> settle drain. Expand only: pre-0546 workers keep
-- calling the unchanged list_unobservable_command_drain_candidates(integer)
-- with their own predicates, so they see no new candidates and take no extra
-- workspace-control locks. A later contract migration may drop that function
-- once no pre-0546 worker remains.
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

-- Truthful containment reason for the drain's settlement notice, recorded at
-- enrollment ('idle_containment' | 'provider_deadline_containment'). A lease
-- enrolled by a pre-0546 worker has none and settles with neutral loss wording.
-- It never outlives the enrollment it describes.
ALTER TABLE sandbox_leases ADD COLUMN command_containment_reason text;
ALTER TABLE sandbox_leases ADD CONSTRAINT sandbox_leases_command_containment_reason_check
  CHECK (command_containment_reason IS NULL
    OR command_containment_reason IN ('idle_containment', 'provider_deadline_containment'));
CREATE FUNCTION opengeni_private.clear_command_containment_reason()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  -- Runs after sandbox_clear_unobservable_command_drain (name order).
  IF NEW.unobservable_command_drain_ids IS NULL THEN
    NEW.command_containment_reason := NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.clear_command_containment_reason() FROM PUBLIC;
CREATE TRIGGER sandbox_command_containment_reason_clear
  BEFORE UPDATE ON sandbox_leases FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.clear_command_containment_reason();

-- The SECURITY DEFINER inventory below runs as the FORCE-RLS table owner under
-- the session-tenancy inventory capability. Grant that capability SELECT on the
-- activity tables its screen reads, exactly as 0345/0391 did for leases,
-- holders, processes and sessions. Inventory-only: the fenced owner policies
-- remain the sole mutation path.
DO $containment_inventory_policies$
DECLARE
  target_schema text := pg_catalog.current_schema();
  target_schema_oid oid := pg_catalog.current_schema()::pg_catalog.regnamespace;
  migration_owner text := current_user;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'session_turns',
    'session_turn_attempts',
    'sandbox_workspace_mutation_admissions',
    'session_system_updates',
    'session_goals'
  ] LOOP
    EXECUTE pg_catalog.format(
      'CREATE POLICY session_tenancy_fence_inventory_read ON %I.%I '
        || 'FOR SELECT USING ('
        || '%I.session_tenancy_fence_owner_policy_active('
        || 'current_user::text, %L::text, %s::oid, workspace_id, true))',
      target_schema,
      table_name,
      target_schema,
      migration_owner,
      target_schema_oid
    );
  END LOOP;
END
$containment_inventory_policies$;

-- Inventory only, independent of command health. It returns enrolled drains,
-- rotating leases, and leases whose only holders are legacy processes and whose
-- durable holder/turn/writer facts are all older than p_idle_ms. Exact
-- enrollment still takes the control fence and process/admission/lease locks
-- and re-checks every fact (plus input waits and pending quiescence) before it
-- changes lifecycle state. A NULL window returns only enrolled and rotating
-- leases.
DO $install$
DECLARE target_schema text := current_schema(); role_name text;
BEGIN
  EXECUTE format($definition$
    CREATE FUNCTION opengeni_private.list_command_containment_candidates(
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
                  -- Unclaimed machine input that will start a turn.
                  OR EXISTS (
                    SELECT 1 FROM %1$I.session_system_updates pending_update
                    WHERE pending_update.workspace_id = member.workspace_id
                      AND pending_update.session_id = member.id
                      AND pending_update.state = 'pending'
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
                      AND turn.status IN ('queued', 'running', 'requires_action', 'recovering',
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
