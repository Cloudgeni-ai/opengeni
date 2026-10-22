-- deployment-mode: rolling
-- Making a chat Only me must never be blocked by records that no longer stand
-- for work or authority. The quiescence check refused idle chats because of:
--   * agent_run_states rows, pending human-input requests and legacy capacity
--     waiters that still pointed at turns which had already ended;
--   * schedules still marked active after their last possible run;
--   * finished background-command notices that the private session would
--     have delivered with another person's frozen authority.
-- The first three are now ignored when their turn is terminal or the schedule
-- is exhausted. The visibility transition cancels the foreign
-- background-command notices itself, in the same transaction, before it
-- checks quiescence. Leftover turns and live work are settled by the
-- application under the same transaction's tenancy fence (see
-- packages/db/src/session-tenancy.ts).
--
-- Blocks that protect another person's authority stay: a foreign pending
-- update of any other kind, another member's live schedule, realtime mode,
-- sandbox access, retained processes and workspace mutation admissions. The
-- standing (non-work) clauses move into session_tenancy_standing_blocker so
-- the owner-only preview session_visibility_change_blocker reports exactly
-- what the transition would still refuse after the work is stopped.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION session_tenancy_standing_blocker(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid
) RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path FROM CURRENT
AS $function$
DECLARE
  session_group_id uuid;
BEGIN
  SELECT sandbox_group_id INTO session_group_id FROM sessions
  WHERE account_id = p_account_id AND workspace_id = p_workspace_id
    AND id = p_session_id;

  IF EXISTS (SELECT 1 FROM session_realtime_modes WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND state = 'active')
    OR EXISTS (SELECT 1 FROM session_realtime_connections WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id
      AND state IN ('negotiating','ready','active'))
  THEN RETURN 'active_realtime';
  ELSIF EXISTS (SELECT 1 FROM scheduled_tasks task WHERE task.workspace_id = p_workspace_id
      AND task.reusable_session_id = p_session_id AND task.status = 'active'
      AND task.deleted_at IS NULL
      AND NOT scheduled_task_is_exhausted(task.id))
  THEN RETURN 'active_scheduled_task';
  ELSIF EXISTS (SELECT 1 FROM sandbox_workspace_mutation_admissions
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id
        AND settled_at IS NULL)
  THEN RETURN 'workspace_mutation_admission';
  ELSIF EXISTS (SELECT 1 FROM sandbox_retained_processes
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id
        AND state = 'active')
  THEN RETURN 'retained_process';
  ELSIF EXISTS (
      SELECT 1 FROM sandbox_lease_holders holder
      JOIN sandbox_leases lease ON lease.id = holder.lease_id
      WHERE lease.workspace_id = p_workspace_id
        AND lease.sandbox_group_id = session_group_id
        AND holder.kind IN ('viewer', 'interaction')
        AND (holder.subject_id IS NULL OR holder.subject_id = p_session_id)
    )
  THEN RETURN 'active_sandbox_access';
  END IF;
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION session_tenancy_standing_blocker(uuid, uuid, uuid) FROM PUBLIC;

-- Owner-only, read-only preview: the blocker a private transition would still
-- raise once the session's own work and leftovers are settled. Foreign
-- background-command notices are excluded because the transition cancels them.
CREATE FUNCTION session_visibility_change_blocker(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid
) RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE
  session_row sessions%ROWTYPE;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_session_id IS NULL
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN RAISE EXCEPTION 'session visibility preview authority is invalid'
    USING ERRCODE = '42501'; END IF;
  SELECT session.* INTO session_row FROM sessions session
  WHERE session.account_id = p_account_id AND session.workspace_id = p_workspace_id
    AND session.id = p_session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'session visibility preview session is unavailable'
    USING ERRCODE = 'P0002'; END IF;
  IF session_row.owner_subject_id IS DISTINCT FROM opengeni_private.current_subject_id() THEN
    RAISE EXCEPTION 'session visibility preview is owner-only' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM session_system_updates pending_update
      WHERE pending_update.workspace_id = p_workspace_id
        AND pending_update.session_id = p_session_id AND pending_update.state = 'pending'
        AND pending_update.kind <> 'background_command_result'
        AND session_system_update_carries_foreign_authority(pending_update,
          session_row.owner_subject_id, session_row.owner_organization_membership_id))
  THEN RETURN 'pending_system_update'; END IF;
  RETURN session_tenancy_standing_blocker(p_account_id, p_workspace_id, p_session_id);
END
$function$;
REVOKE ALL ON FUNCTION session_visibility_change_blocker(uuid, uuid, uuid) FROM PUBLIC;

DO $pin$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.session_tenancy_standing_blocker(uuid, uuid, uuid) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema);
  EXECUTE format('ALTER FUNCTION %I.session_visibility_change_blocker(uuid, uuid, uuid) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.session_visibility_change_blocker(uuid, uuid, uuid) TO opengeni_app',
      data_schema);
  END IF;
END
$pin$;

DO $migration$
DECLARE
  definition text;
BEGIN
  definition := pg_get_functiondef('assert_session_tenancy_quiescent(uuid,uuid,uuid,boolean)'::regprocedure);
  IF strpos(definition, 'session_tenancy_standing_blocker') > 0 THEN
    RAISE EXCEPTION 'tenancy quiescence leftover rewrite already applied';
  END IF;
  definition := replace(definition, '  ELSIF EXISTS (SELECT 1 FROM session_human_input_requests WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND status = ''pending'')
  THEN blocker := ''pending_human_input'';',
    '  ELSIF EXISTS (SELECT 1 FROM session_human_input_requests request
      WHERE request.workspace_id = p_workspace_id
        AND request.session_id = p_session_id AND request.status = ''pending''
        AND NOT EXISTS (SELECT 1 FROM session_turns request_turn
          WHERE request_turn.workspace_id = request.workspace_id
            AND request_turn.id = request.turn_id
            AND request_turn.status IN (
              ''completed'',''failed'',''cancelled'',''superseded'',''withdrawn_for_edit'')))
  THEN blocker := ''pending_human_input'';');
  definition := replace(definition, '  ELSIF EXISTS (SELECT 1 FROM agent_run_states WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id)
  THEN blocker := ''run_state'';',
    '  ELSIF EXISTS (SELECT 1 FROM agent_run_states run_state
      WHERE run_state.workspace_id = p_workspace_id
        AND run_state.session_id = p_session_id
        AND NOT EXISTS (SELECT 1 FROM session_turns state_turn
          WHERE state_turn.workspace_id = run_state.workspace_id
            AND state_turn.id = run_state.turn_id
            AND state_turn.status IN (
              ''completed'',''failed'',''cancelled'',''superseded'',''withdrawn_for_edit'')))
  THEN blocker := ''run_state'';');
  definition := replace(definition, '  ELSIF EXISTS (SELECT 1 FROM codex_capacity_waiters WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND status = ''waiting'')
    OR EXISTS (SELECT 1 FROM xai_capacity_waiters WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND status = ''waiting'')
  THEN blocker := ''capacity_waiter'';',
    '  ELSIF EXISTS (SELECT 1 FROM codex_capacity_waiters waiter
      WHERE waiter.workspace_id = p_workspace_id
        AND waiter.session_id = p_session_id AND waiter.status = ''waiting''
        AND EXISTS (SELECT 1 FROM session_turns waiting_turn
          WHERE waiting_turn.workspace_id = waiter.workspace_id
            AND waiting_turn.id = waiter.blocked_turn_id
            AND waiting_turn.status IN (
              ''queued'',''running'',''requires_action'',''recovering'',''waiting_capacity'')))
    OR EXISTS (SELECT 1 FROM xai_capacity_waiters waiter
      WHERE waiter.workspace_id = p_workspace_id
        AND waiter.session_id = p_session_id AND waiter.status = ''waiting''
        AND EXISTS (SELECT 1 FROM session_turns waiting_turn
          WHERE waiting_turn.workspace_id = waiter.workspace_id
            AND waiting_turn.id = waiter.blocked_turn_id
            AND waiting_turn.status IN (
              ''queued'',''running'',''requires_action'',''recovering'',''waiting_capacity'')))
  THEN blocker := ''capacity_waiter'';');
  definition := replace(definition, '  ELSIF EXISTS (SELECT 1 FROM session_realtime_modes WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND state = ''active'')
    OR EXISTS (SELECT 1 FROM session_realtime_connections WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id
      AND state IN (''negotiating'',''ready'',''active''))
  THEN blocker := ''active_realtime'';
  ELSIF EXISTS (SELECT 1 FROM scheduled_tasks WHERE workspace_id = p_workspace_id
      AND reusable_session_id = p_session_id AND status = ''active'')
  THEN blocker := ''active_scheduled_task'';
  ELSIF EXISTS (SELECT 1 FROM sandbox_workspace_mutation_admissions
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id
        AND settled_at IS NULL)
  THEN blocker := ''workspace_mutation_admission'';
  ELSIF EXISTS (SELECT 1 FROM sandbox_retained_processes
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id
        AND state = ''active'')
  THEN blocker := ''retained_process'';
  ELSIF EXISTS (
      SELECT 1 FROM sandbox_lease_holders holder
      JOIN sandbox_leases lease ON lease.id = holder.lease_id
      WHERE lease.workspace_id = p_workspace_id
        AND lease.sandbox_group_id = session_group_id
        AND holder.kind IN (''viewer'', ''interaction'')
        AND (holder.subject_id IS NULL OR holder.subject_id = p_session_id)
    )
  THEN blocker := ''active_sandbox_access'';
  END IF;',
    '  ELSE
    blocker := session_tenancy_standing_blocker(p_account_id, p_workspace_id, p_session_id);
  END IF;');
  -- Exactly-once guard: each rewritten clause leaves a unique marker, so a
  -- clause another migration already reshaped fails closed here.
  IF (length(definition) - length(replace(definition, 'request_turn.status IN (', ''))) / length('request_turn.status IN (') <> 1
    OR (length(definition) - length(replace(definition, 'state_turn.status IN (', ''))) / length('state_turn.status IN (') <> 1
    OR (length(definition) - length(replace(definition, 'waiting_turn.status IN (', ''))) / length('waiting_turn.status IN (') <> 2
    OR (length(definition) - length(replace(definition, 'blocker := session_tenancy_standing_blocker(', ''))) / length('blocker := session_tenancy_standing_blocker(') <> 1
  THEN
    RAISE EXCEPTION 'tenancy quiescence leftover rewrite did not match exactly once';
  END IF;
  EXECUTE definition;
END
$migration$;

DO $migration$
DECLARE
  definition text;
BEGIN
  definition := pg_get_functiondef(
    'transition_session_visibility(uuid,uuid,uuid,text,text,integer,text,text,integer)'::regprocedure);
  IF strpos(definition, 'background_command_result') > 0 THEN
    RAISE EXCEPTION 'visibility leftover rewrite already applied';
  END IF;
  definition := replace(definition, '  previous_lifecycle text := current_setting(''opengeni.organization_tenancy_lifecycle'', true);
BEGIN',
    '  previous_lifecycle text := current_setting(''opengeni.organization_tenancy_lifecycle'', true);
  cancelled_update_ids uuid[] := ARRAY[]::uuid[];
  cancelled_update_id uuid;
BEGIN');
  definition := replace(definition, '    IF p_target_visibility = ''user_private'' THEN
      PERFORM assert_session_tenancy_quiescent(p_account_id, p_workspace_id, p_session_id, false);
    END IF;',
    '    IF p_target_visibility = ''user_private'' THEN
      -- A finished background command that only waits for the next turn would
      -- be delivered to the private session with another person''s frozen
      -- authority. Nobody consumes it while the chat is idle; cancel it as
      -- part of this change instead of refusing the change.
      WITH cancelled AS (
        UPDATE session_system_updates pending_update SET state = ''cancelled''
        WHERE pending_update.workspace_id = p_workspace_id
          AND pending_update.session_id = p_session_id
          AND pending_update.state = ''pending''
          AND pending_update.kind = ''background_command_result''
          AND session_system_update_carries_foreign_authority(pending_update,
            session_row.owner_subject_id, session_row.owner_organization_membership_id)
        RETURNING pending_update.id, pending_update.created_at
      )
      SELECT COALESCE(array_agg(cancelled.id ORDER BY cancelled.created_at, cancelled.id),
        ARRAY[]::uuid[])
      INTO cancelled_update_ids FROM cancelled;
      FOREACH cancelled_update_id IN ARRAY cancelled_update_ids LOOP
        session_row.last_sequence := session_row.last_sequence + 1;
        INSERT INTO session_events (
          account_id, workspace_id, session_id, sequence, type, payload, occurred_at
        ) VALUES (
          p_account_id, p_workspace_id, p_session_id, session_row.last_sequence,
          ''system.update.cancelled'',
          jsonb_build_object(''updateId'', cancelled_update_id, ''reason'', ''authority_changed''),
          clock_timestamp()
        );
      END LOOP;
      PERFORM assert_session_tenancy_quiescent(p_account_id, p_workspace_id, p_session_id, false);
    END IF;');
  definition := replace(definition, '        ''cancelledUpdateCount'', 0, ''pausedGoalCount'', 0,',
    '        ''cancelledUpdateCount'', cardinality(cancelled_update_ids), ''pausedGoalCount'', 0,');
  definition := replace(definition, '  cancelled_update_count := 0; paused_goal_count := 0;
  revoked_grant_count := grant_count;',
    '  cancelled_update_count := cardinality(cancelled_update_ids); paused_goal_count := 0;
  revoked_grant_count := grant_count;');
  -- Exactly-once guard: each rewritten clause leaves a unique marker, so a
  -- clause another migration already reshaped fails closed here.
  IF (length(definition) - length(replace(definition, 'cancelled_update_ids uuid[]', ''))) / length('cancelled_update_ids uuid[]') <> 1
    OR (length(definition) - length(replace(definition, 'system.update.cancelled', ''))) / length('system.update.cancelled') <> 1
    OR (length(definition) - length(replace(definition, 'cardinality(cancelled_update_ids)', ''))) / length('cardinality(cancelled_update_ids)') <> 2
  THEN
    RAISE EXCEPTION 'visibility leftover rewrite did not match exactly once';
  END IF;
  EXECUTE definition;
END
$migration$;
