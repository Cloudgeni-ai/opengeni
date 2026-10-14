-- deployment-mode: rolling
-- Making a chat Only me never refuses because of what is in it. 0768 settled
-- leftovers and stopped the chat's own work with consent, but still refused
-- for things that do not need to stop or that the change can simply drop:
--   * another member's pending machine input (only a finished background
--     command result was cancelled);
--   * another member's subscription account choice for the chat;
--   * a live schedule, an open sandbox viewer, a retained process or an
--     in-flight sandbox file operation.
-- None of the last group carries authority into the private chat: schedule
-- runs are admitted per run under their owner's own session access, and
-- sandbox processes, file operations and viewers record the session
-- authority epoch and visibility they were admitted under, which stop
-- matching once the chat becomes private (0738: sandbox files are as shared
-- as the sandbox; the conversation is what visibility protects).
--
-- 1. session_private_transition_blocker: what a private change still needs
--    settled first - the chat's own work (settled by the application in the
--    same transaction, with consent where it is visible) and a live voice
--    session. Forks and Variable Set changes keep the full
--    assert_session_tenancy_quiescent check.
-- 2. transition_session_visibility cancels every pending update that carries
--    another person's authority and removes subscription account choices the
--    owner cannot use, then checks session_private_transition_blocker.
-- 3. A private chat never accepts another person's authority later either: a
--    pending update inserted with foreign authority (for example the result
--    of a command another member started before the change) is stored
--    cancelled instead of waiting for delivery. Scheduled occurrences keep
--    their own accepted-execution validation.
-- 4. session_visibility_foreign_authority_items: owner-only counts the
--    confirmation shows. session_visibility_change_blocker (0768) now always
--    answers NULL, so an older release's preview and stop path no longer
--    report blocks that are gone.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION session_private_transition_blocker(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid
) RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path FROM CURRENT
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM session_turns WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id
      AND status IN ('queued','running','requires_action','recovering','waiting_capacity'))
  THEN RETURN 'nonterminal_turn';
  ELSIF EXISTS (SELECT 1 FROM session_turn_attempts WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND state <> 'closed')
  THEN RETURN 'nonterminal_attempt';
  ELSIF EXISTS (SELECT 1 FROM session_attempt_interruptions WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND state IN ('pending','delivered','acknowledged'))
  THEN RETURN 'unsettled_interruption';
  ELSIF EXISTS (SELECT 1 FROM session_system_updates pending_update
      JOIN sessions update_owner ON update_owner.id = pending_update.session_id
      WHERE pending_update.workspace_id = p_workspace_id
        AND pending_update.session_id = p_session_id AND pending_update.state = 'pending'
        AND session_system_update_carries_foreign_authority(pending_update,
          update_owner.owner_subject_id, update_owner.owner_organization_membership_id))
  THEN RETURN 'pending_system_update';
  ELSIF EXISTS (SELECT 1 FROM session_human_input_requests request
      WHERE request.workspace_id = p_workspace_id
        AND request.session_id = p_session_id AND request.status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM session_turns request_turn
          WHERE request_turn.workspace_id = request.workspace_id
            AND request_turn.id = request.turn_id
            AND request_turn.status IN (
              'completed','failed','cancelled','superseded','withdrawn_for_edit')))
  THEN RETURN 'pending_human_input';
  ELSIF EXISTS (SELECT 1 FROM session_pending_tool_calls pending
      WHERE pending.workspace_id = p_workspace_id
        AND pending.session_id = p_session_id
        AND (EXISTS (SELECT 1 FROM session_turns owner_turn
            WHERE owner_turn.workspace_id = pending.workspace_id
              AND owner_turn.id = pending.turn_id
              AND owner_turn.status NOT IN (
                'completed','failed','cancelled','superseded','withdrawn_for_edit'))
          OR EXISTS (SELECT 1 FROM session_turn_attempts owner_attempt
            WHERE owner_attempt.workspace_id = pending.workspace_id
              AND owner_attempt.id = pending.attempt_id
              AND owner_attempt.state <> 'closed')))
  THEN RETURN 'pending_tool_receipt';
  ELSIF EXISTS (SELECT 1 FROM agent_run_states run_state
      WHERE run_state.workspace_id = p_workspace_id
        AND run_state.session_id = p_session_id
        AND NOT EXISTS (SELECT 1 FROM session_turns state_turn
          WHERE state_turn.workspace_id = run_state.workspace_id
            AND state_turn.id = run_state.turn_id
            AND state_turn.status IN (
              'completed','failed','cancelled','superseded','withdrawn_for_edit')))
  THEN RETURN 'run_state';
  ELSIF EXISTS (SELECT 1 FROM session_goals WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND status = 'active')
  THEN RETURN 'active_goal';
  ELSIF EXISTS (SELECT 1 FROM session_realtime_modes WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND state = 'active')
    OR EXISTS (SELECT 1 FROM session_realtime_connections WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id
      AND state IN ('negotiating','ready','active'))
  THEN RETURN 'active_realtime';
  END IF;
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION session_private_transition_blocker(uuid, uuid, uuid) FROM PUBLIC;

-- Subscription account choices on the chat that the owner cannot use: a
-- personal connection of anyone else, or a connection the owner cannot see.
CREATE FUNCTION session_foreign_subscription_binding_count(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_owner_subject_id text
) RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path FROM CURRENT
AS $function$
BEGIN
  RETURN (SELECT count(*)::integer FROM subscription_session_bindings binding
    WHERE binding.account_id = p_account_id AND binding.workspace_id = p_workspace_id
      AND binding.session_id = p_session_id AND binding.connection_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM subscription_connections connection
        WHERE connection.account_id = binding.account_id
          AND connection.id = binding.connection_id
          AND (connection.ownership <> 'personal'
            OR connection.owner_subject_id = p_owner_subject_id)));
END
$function$;
REVOKE ALL ON FUNCTION session_foreign_subscription_binding_count(uuid, uuid, uuid, text) FROM PUBLIC;

-- Owner-only, read-only counts for the "make private" confirmation. A
-- finished background-command notice is a leftover nobody consumes on its
-- own; it is dropped silently, as since 0768, and not listed.
CREATE FUNCTION session_visibility_foreign_authority_items(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid
) RETURNS TABLE (pending_update_count integer, account_choice_count integer)
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
  SELECT count(*)::integer INTO pending_update_count FROM session_system_updates pending_update
  WHERE pending_update.workspace_id = p_workspace_id
    AND pending_update.session_id = p_session_id AND pending_update.state = 'pending'
    AND pending_update.kind <> 'background_command_result'
    AND session_system_update_carries_foreign_authority(pending_update,
      session_row.owner_subject_id, session_row.owner_organization_membership_id);
  account_choice_count := session_foreign_subscription_binding_count(
    p_account_id, p_workspace_id, p_session_id, session_row.owner_subject_id);
  RETURN NEXT;
END
$function$;
REVOKE ALL ON FUNCTION session_visibility_foreign_authority_items(uuid, uuid, uuid) FROM PUBLIC;

-- 0768's preview of a standing block: nothing stands any more.
CREATE OR REPLACE FUNCTION session_visibility_change_blocker(
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
  RETURN NULL;
END
$function$;

-- A private chat accepts no one else's authority, also after the change.
CREATE FUNCTION private_session_cancels_foreign_update() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $function$
DECLARE
  target_visibility text;
  target_owner_subject_id text;
  target_owner_membership_id uuid;
BEGIN
  IF NEW.state <> 'pending' OR NEW.kind = 'scheduled_occurrence' THEN
    RETURN NEW;
  END IF;
  SELECT session.visibility, session.owner_subject_id, session.owner_organization_membership_id
  INTO target_visibility, target_owner_subject_id, target_owner_membership_id
  FROM sessions session
  WHERE session.workspace_id = NEW.workspace_id AND session.id = NEW.session_id;
  IF target_visibility = 'user_private'
    AND session_system_update_carries_foreign_authority(NEW,
      target_owner_subject_id, target_owner_membership_id)
  THEN
    NEW.state := 'cancelled';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION private_session_cancels_foreign_update() FROM PUBLIC;
CREATE TRIGGER private_session_cancels_foreign_update
  BEFORE INSERT ON session_system_updates
  FOR EACH ROW EXECUTE FUNCTION private_session_cancels_foreign_update();

DO $pin$
DECLARE data_schema text := current_schema();
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'session_private_transition_blocker(uuid, uuid, uuid)',
    'session_foreign_subscription_binding_count(uuid, uuid, uuid, text)',
    'session_visibility_foreign_authority_items(uuid, uuid, uuid)',
    'session_visibility_change_blocker(uuid, uuid, uuid)',
    'private_session_cancels_foreign_update()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = pg_catalog, %I, pg_temp',
      data_schema, signature, data_schema);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.session_visibility_foreign_authority_items(uuid, uuid, uuid) TO opengeni_app',
      data_schema);
  END IF;
END
$pin$;

DO $migration$
DECLARE
  definition text;
BEGIN
  definition := pg_get_functiondef(
    'transition_session_visibility(uuid,uuid,uuid,text,text,integer,text,text,integer)'::regprocedure);
  IF strpos(definition, 'session_private_transition_blocker') > 0 THEN
    RAISE EXCEPTION 'private visibility never-blocks rewrite already applied';
  END IF;
  definition := replace(definition, $old$  cancelled_update_id uuid;
BEGIN$old$, $new$  cancelled_update_id uuid;
  private_blocker text;
BEGIN$new$);
  definition := replace(definition, $old$      -- A finished background command that only waits for the next turn would
      -- be delivered to the private session with another person's frozen
      -- authority. Nobody consumes it while the chat is idle; cancel it as
      -- part of this change instead of refusing the change.
      WITH cancelled AS (
        UPDATE session_system_updates pending_update SET state = 'cancelled'
        WHERE pending_update.workspace_id = p_workspace_id
          AND pending_update.session_id = p_session_id
          AND pending_update.state = 'pending'
          AND pending_update.kind = 'background_command_result'
          AND session_system_update_carries_foreign_authority(pending_update,$old$,
    $new$      -- A private chat accepts no one else's authority. Pending machine input
      -- that carries another person's frozen authority is cancelled as part
      -- of this change instead of refusing it.
      WITH cancelled AS (
        UPDATE session_system_updates pending_update SET state = 'cancelled'
        WHERE pending_update.workspace_id = p_workspace_id
          AND pending_update.session_id = p_session_id
          AND pending_update.state = 'pending'
          AND session_system_update_carries_foreign_authority(pending_update,$new$);
  definition := replace(definition, $old$      PERFORM assert_session_tenancy_quiescent(p_account_id, p_workspace_id, p_session_id, false);
    END IF;$old$,
    $new$      -- A subscription account choice the owner cannot use is removed; the
      -- next response is placed automatically.
      DELETE FROM subscription_session_bindings binding
      WHERE binding.account_id = p_account_id AND binding.workspace_id = p_workspace_id
        AND binding.session_id = p_session_id AND binding.connection_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM subscription_connections connection
          WHERE connection.account_id = binding.account_id
            AND connection.id = binding.connection_id
            AND (connection.ownership <> 'personal'
              OR connection.owner_subject_id = session_row.owner_subject_id));
      -- The application settled the chat's own work under this transaction's
      -- tenancy fence; only what a private chat cannot keep is checked here.
      private_blocker := session_private_transition_blocker(
        p_account_id, p_workspace_id, p_session_id);
      IF private_blocker IS NOT NULL THEN
        RAISE EXCEPTION 'session tenancy mutation requires a quiescent session'
          USING ERRCODE = '55P03', DETAIL = private_blocker;
      END IF;
    END IF;$new$);
  -- Exactly-once guard: each rewritten clause leaves a unique marker, so a
  -- clause another migration already reshaped fails closed here.
  IF (length(definition) - length(replace(definition, 'private_blocker text;', ''))) / length('private_blocker text;') <> 1
    OR strpos(definition, 'background_command_result') > 0
    OR strpos(definition, 'assert_session_tenancy_quiescent') > 0
    OR (length(definition) - length(replace(definition, 'DELETE FROM subscription_session_bindings', ''))) / length('DELETE FROM subscription_session_bindings') <> 1
    OR (length(definition) - length(replace(definition, 'private_blocker := session_private_transition_blocker(', ''))) / length('private_blocker := session_private_transition_blocker(') <> 1
  THEN
    RAISE EXCEPTION 'private visibility never-blocks rewrite did not match exactly once';
  END IF;
  EXECUTE definition;
END
$migration$;
