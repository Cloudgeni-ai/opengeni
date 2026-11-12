-- deployment-mode: rolling
-- A continuation turn (a goal continuation, a finished wait or background
-- command, a child's result) inherited the learning modes of the turn that
-- caused it, and that turn's modes came from the turn that caused it, back to
-- the first turn of the chain. A chain can run for days. Turns a person or a
-- schedule starts resolve the settings as they are when the turn is accepted,
-- so after someone changed their settings one chat alternated between the old
-- and the new modes depending on which kind of turn ran. Every alternation
-- changed the model-visible governance block, which is sent again in full.
--
-- Now a continuation takes the modes its chat accepted most recently (the
-- newest snapshot of an earlier turn of the same chat, owner layer and
-- setting context, no older than the turn that caused it). That is the turn
-- that caused it unless a later turn of the chat has run since, so a chain
-- with nothing after it keeps exactly the policy it was accepted under, and
-- a setting change still applies from the next turn a person or a schedule
-- starts. Explicit chat overrides still win, scheduled-run provenance still
-- follows the causing turn, and a child's first turn still inherits from the
-- parent turn that created it.
-- Previous binaries: accepted snapshots never change. Only turns accepted
-- after this migration resolve with the new rule; the function signature and
-- the snapshot shape are unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $learning_continuation_follows_chat$
DECLARE definition text; anchor text;
BEGIN
  definition := pg_get_functiondef(format(
    '%I.knowledge_learning_for_turn(uuid,uuid,uuid)', current_schema())::regprocedure);

  anchor := $a$  result jsonb; inherited jsonb; current_policy jsonb; subject text; destination text;
$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'knowledge_learning_for_turn declaration anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$  result jsonb; inherited jsonb; current_policy jsonb; subject text; destination text;
  latest jsonb; cause_position bigint;
$r$);

  anchor := $a$  IF producer IS NOT NULL THEN
    inherited:=knowledge_learning_for_turn(p_account,p_workspace,producer);
$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'knowledge_learning_for_turn producer anchor drifted';
  END IF;
  definition := replace(definition, anchor, anchor || $r$    -- A continuation in the same chat follows the modes the chat accepted
    -- most recently since its cause, so it never brings back an older
    -- policy. Provenance (scheduledTaskRunId) still follows the cause.
    SELECT cause.position INTO cause_position FROM session_turns cause
      WHERE cause.id=producer AND cause.account_id=p_account AND cause.workspace_id=p_workspace
        AND cause.session_id=s.id;
    IF cause_position IS NOT NULL THEN
      -- Newest first on session_turns_session_position_idx; each snapshot is
      -- read by its key and the scan stops at the first match.
      SELECT snap.snapshot INTO latest FROM session_turns prior
        JOIN agent_learning_snapshots snap ON snap.account_id=p_account AND snap.turn_id=prior.id
        WHERE prior.workspace_id=p_workspace AND prior.session_id=s.id
          AND prior.position>=cause_position AND prior.position<t.position
          AND snap.snapshot->>'ownerKey' IS NOT DISTINCT FROM current_policy->>'ownerKey'
          AND snap.snapshot->>'contextKey' IS NOT DISTINCT FROM current_policy->>'contextKey'
        ORDER BY prior.position DESC LIMIT 1;
    END IF;
    IF latest IS NOT NULL THEN
      inherited:=inherited||jsonb_build_object('effective',latest->'effective');
    END IF;
$r$);
  EXECUTE definition;
END $learning_continuation_follows_chat$;
