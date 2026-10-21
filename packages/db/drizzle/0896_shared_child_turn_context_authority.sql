-- deployment-mode: rolling
-- A chat shared with the workspace can be a child of a chat its owner kept
-- private. Another member may open and prompt the shared child, but every
-- such turn failed before the model ran: the turn-start Company Brain context
-- selection reused the task-note authority, which requires the whole task
-- tree (the private parent included) to be visible to the turn's human.
--
-- Task notes are tree-wide coordination, so they keep that rule. The context
-- selection only needs the exact current turn and attempt, and the addressed
-- chat visible to the turn's human; the root is just the tree's identity.
--
-- 1. resolve_turn_context_attempt_authority: the task-note authority checks
--    without the tree-wide visibility requirement and without the root lock
--    that serializes task-note writes. It is an invoker routine with no
--    EXECUTE grant; only the definer selection function below calls it.
-- 2. company_brain_context_get_or_create_selection calls it instead. Only that
--    call is rewritten; pg_get_functiondef + CREATE OR REPLACE preserve owner,
--    ACL, SECURITY DEFINER, search_path and every other predicate.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION resolve_turn_context_attempt_authority(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer
) RETURNS TABLE(
  root_session_id uuid,
  actor_kind text,
  actor_subject_id text,
  initiating_human_subject_id text
)
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $function$
DECLARE
  resolved_root_id uuid;
  turn_row session_turns%ROWTYPE;
  previous_subject_id text := pg_catalog.current_setting('opengeni.subject_id', true);
  previous_initiating_human_subject_id text := pg_catalog.current_setting(
    'opengeni.initiating_human_subject_id', true
  );
  visibility_context_set boolean := false;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_session_id IS NULL
    OR p_turn_id IS NULL OR p_attempt_id IS NULL
    OR p_execution_generation IS NULL OR p_execution_generation < 1
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN
    RAISE EXCEPTION 'turn context requires exact tenant and attempt authority'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM workspaces workspace
  WHERE workspace.account_id = p_account_id AND workspace.id = p_workspace_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'turn context workspace is unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT session.root_session_id INTO resolved_root_id
  FROM sessions session
  WHERE session.account_id = p_account_id
    AND session.workspace_id = p_workspace_id
    AND session.id = p_session_id;
  IF resolved_root_id IS NULL THEN
    RAISE EXCEPTION 'turn context session is unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT turn.* INTO turn_row
  FROM session_turns turn
  JOIN sessions session ON session.account_id = turn.account_id
    AND session.workspace_id = turn.workspace_id
    AND session.id = turn.session_id
  WHERE turn.account_id = p_account_id
    AND turn.workspace_id = p_workspace_id
    AND turn.session_id = p_session_id
    AND turn.id = p_turn_id
    AND turn.active_attempt_id = p_attempt_id
    AND session.active_turn_id = p_turn_id
    AND turn.execution_generation = p_execution_generation
    AND turn.status IN ('running','requires_action','recovering','waiting_capacity')
  FOR SHARE OF turn;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'turn context requires the exact current turn' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM session_turn_attempts attempt
  WHERE attempt.account_id = p_account_id
    AND attempt.workspace_id = p_workspace_id
    AND attempt.session_id = p_session_id
    AND attempt.turn_id = p_turn_id
    AND attempt.id = p_attempt_id
    AND attempt.execution_generation = p_execution_generation
    AND attempt.state IN ('claimed','running')
    AND NOT EXISTS (
      SELECT 1 FROM session_attempt_interruptions interruption
      WHERE interruption.workspace_id = attempt.workspace_id
        AND interruption.attempt_id = attempt.id
        AND interruption.state IN ('pending','delivered','acknowledged')
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'turn context requires the exact current attempt' USING ERRCODE = '42501';
  END IF;

  -- A worker connection is transport, not session-visibility authority. Check
  -- the addressed chat under the human authority frozen on the accepted turn,
  -- then restore the caller's GUCs. Pure service work supplies no human.
  PERFORM pg_catalog.set_config(
    'opengeni.subject_id',
    CASE WHEN turn_row.initiator_kind = 'subject'
      THEN turn_row.initiator_subject_id ELSE '' END,
    true
  );
  PERFORM pg_catalog.set_config(
    'opengeni.initiating_human_subject_id',
    COALESCE(turn_row.initiating_human_subject_id, ''),
    true
  );
  visibility_context_set := true;
  IF NOT EXISTS (
    SELECT 1 FROM sessions session
    WHERE session.account_id = p_account_id
      AND session.workspace_id = p_workspace_id
      AND session.id = p_session_id
      AND (
        session.visibility = 'workspace_shared'
        OR session_private_actor_visible(
          session.account_id,
          session.workspace_id,
          session.owner_organization_membership_id,
          session.owner_subject_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'turn context session is not visible to this actor'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.subject_id', COALESCE(previous_subject_id, ''), true
  );
  PERFORM pg_catalog.set_config(
    'opengeni.initiating_human_subject_id',
    COALESCE(previous_initiating_human_subject_id, ''),
    true
  );
  visibility_context_set := false;

  root_session_id := resolved_root_id;
  actor_kind := CASE turn_row.initiator_kind WHEN 'subject' THEN 'human' ELSE 'service' END;
  actor_subject_id := turn_row.initiator_subject_id;
  initiating_human_subject_id := turn_row.initiating_human_subject_id;
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  IF visibility_context_set THEN
    PERFORM pg_catalog.set_config(
      'opengeni.subject_id', COALESCE(previous_subject_id, ''), true
    );
    PERFORM pg_catalog.set_config(
      'opengeni.initiating_human_subject_id',
      COALESCE(previous_initiating_human_subject_id, ''),
      true
    );
  END IF;
  RAISE;
END;
$function$;

REVOKE ALL ON FUNCTION resolve_turn_context_attempt_authority(
  uuid, uuid, uuid, uuid, uuid, integer
) FROM PUBLIC;

DO $pin$
DECLARE data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.resolve_turn_context_attempt_authority('
      || 'uuid,uuid,uuid,uuid,uuid,integer) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
END
$pin$;

DO $migration$
DECLARE
  target regprocedure := pg_catalog.to_regprocedure(
    pg_catalog.quote_ident(pg_catalog.current_schema()) ||
    '.company_brain_context_get_or_create_selection(uuid,uuid,uuid,uuid,uuid,integer)'
  );
  definition text := pg_catalog.pg_get_functiondef(target);
  before_call text := 'FROM resolve_task_note_attempt_authority(';
  after_call text := 'FROM resolve_turn_context_attempt_authority(';
  before_count integer;
  after_count integer;
BEGIN
  IF definition IS NULL THEN
    RAISE EXCEPTION 'Company Brain context selection function is missing' USING ERRCODE = '55000';
  END IF;
  before_count := (length(definition) - length(replace(definition, before_call, '')))
    / length(before_call);
  after_count := (length(definition) - length(replace(definition, after_call, '')))
    / length(after_call);
  IF before_count = 0 AND after_count = 1 THEN
    RETURN;
  END IF;
  IF before_count <> 1 OR after_count <> 0 THEN
    RAISE EXCEPTION 'Company Brain context selection authority source contract changed'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, before_call, after_call);
END
$migration$;
