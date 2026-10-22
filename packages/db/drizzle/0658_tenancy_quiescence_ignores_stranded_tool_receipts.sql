-- deployment-mode: rolling
-- A completed turn does not consume its session_pending_tool_calls receipts
-- (only failed/cancelled/superseded settlement does), and the worker's durable
-- clear misses approval-resumed calls and rows without a recorded result. Such
-- a receipt is stranded: its turn is terminal and its attempt has settled, so
-- nothing can resume it and nothing can resolve it. Counting it as a
-- quiescence blocker refused visibility changes and whole-session forks
-- forever with "Resolve the pending tool request first".
--
-- Count only live receipts, with the same predicate session Retry and sandbox
-- group recovery already use: the owning turn is nonterminal, or the owning
-- attempt is still open or closed without its interruption quiescence
-- receipt. A nonterminal turn or an open attempt is already reported by the
-- earlier nonterminal_turn / nonterminal_attempt blockers, so the only case
-- this clause still reports on its own is a closed attempt with an
-- interruption but no quiescence receipt. Whole-session forks and visibility
-- transitions still require full quiescence; only the receipt clause changes.
DO $migration$
DECLARE
  definition text;
BEGIN
  definition := pg_get_functiondef('assert_session_tenancy_quiescent(uuid,uuid,uuid,boolean)'::regprocedure);
  -- Exactly-once guard in the 0502 style. The receipt blocker assignment is
  -- the tail of the replaced clause, so one occurrence of it plus the marker
  -- check after replace() proves exactly one clause was rewritten.
  IF (length(definition) - length(replace(definition, 'THEN blocker := ''pending_tool_receipt'';', '')))
      / length('THEN blocker := ''pending_tool_receipt'';') <> 1
    OR strpos(definition, 'owner_attempt.quiesced_at') > 0
  THEN
    RAISE EXCEPTION 'stranded tool receipt quiescence rewrite did not match exactly once';
  END IF;
  -- Reuse the current definition so every other blocker, the singleton-group
  -- check, SECURITY DEFINER and the search_path posture stay byte-identical.
  definition := replace(definition, '  ELSIF EXISTS (SELECT 1 FROM session_pending_tool_calls WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id)
  THEN blocker := ''pending_tool_receipt'';', '  ELSIF EXISTS (SELECT 1 FROM session_pending_tool_calls pending
      WHERE pending.workspace_id = p_workspace_id
        AND pending.session_id = p_session_id
        AND (EXISTS (SELECT 1 FROM session_turns owner_turn
            WHERE owner_turn.workspace_id = pending.workspace_id
              AND owner_turn.id = pending.turn_id
              AND owner_turn.status NOT IN (
                ''completed'',''failed'',''cancelled'',''superseded'',''withdrawn_for_edit''))
          OR EXISTS (SELECT 1 FROM session_turn_attempts owner_attempt
            WHERE owner_attempt.workspace_id = pending.workspace_id
              AND owner_attempt.id = pending.attempt_id
              AND (owner_attempt.state <> ''closed''
                OR (owner_attempt.quiesced_at IS NULL AND EXISTS (
                  SELECT 1 FROM session_attempt_interruptions interruption
                  WHERE interruption.attempt_id = owner_attempt.id))))))
  THEN blocker := ''pending_tool_receipt'';');
  IF strpos(definition, 'owner_attempt.quiesced_at') = 0 THEN
    RAISE EXCEPTION 'stranded tool receipt quiescence rewrite did not match';
  END IF;
  EXECUTE definition;
END
$migration$;
