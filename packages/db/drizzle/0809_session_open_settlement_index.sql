-- deployment-mode: rolling
-- Session control summaries ("stopping" badges) count interruptions that are
-- still open: not yet settled, or settled while their attempt has not yet
-- recorded physical quiescence. Answering that by walking every requested
-- session's subtree, or by scanning the workspace's whole interruption history,
-- grows with history even though almost every interruption is long finished.
--
-- attempt_quiesced is a monotonic hint copied from the interruption's attempt
-- (session_turn_attempts.quiesced_at only ever moves from NULL to a time). It
-- lets one small partial index hold exactly the interruptions that can still
-- be open. Readers keep checking the attempt itself, so a hint that is still
-- false (for example an interruption inserted concurrently with its attempt's
-- quiescence) only leaves an extra row in the index; it never changes a result.
SET LOCAL lock_timeout = '5s';

ALTER TABLE session_attempt_interruptions
  ADD COLUMN attempt_quiesced boolean NOT NULL DEFAULT false;

CREATE FUNCTION session_attempt_interruption_fill_quiescence_hint()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $fill_quiescence_hint$
BEGIN
  NEW.attempt_quiesced := coalesce((
    SELECT attempt.quiesced_at IS NOT NULL
    FROM session_turn_attempts attempt
    WHERE attempt.workspace_id = NEW.workspace_id
      AND attempt.id = NEW.attempt_id
  ), false);
  RETURN NEW;
END
$fill_quiescence_hint$;
REVOKE ALL ON FUNCTION session_attempt_interruption_fill_quiescence_hint() FROM PUBLIC;

CREATE TRIGGER session_attempt_interruptions_fill_quiescence_hint
  BEFORE INSERT ON session_attempt_interruptions
  FOR EACH ROW EXECUTE FUNCTION session_attempt_interruption_fill_quiescence_hint();

CREATE FUNCTION session_turn_attempt_propagate_quiescence_hint()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $propagate_quiescence_hint$
BEGIN
  UPDATE session_attempt_interruptions interruption
  SET attempt_quiesced = true
  WHERE interruption.workspace_id = NEW.workspace_id
    AND interruption.attempt_id = NEW.id
    AND NOT interruption.attempt_quiesced;
  RETURN NULL;
END
$propagate_quiescence_hint$;
REVOKE ALL ON FUNCTION session_turn_attempt_propagate_quiescence_hint() FROM PUBLIC;

CREATE TRIGGER session_turn_attempts_propagate_quiescence_hint
  AFTER UPDATE OF quiesced_at ON session_turn_attempts
  FOR EACH ROW
  WHEN (OLD.quiesced_at IS NULL AND NEW.quiesced_at IS NOT NULL)
  EXECUTE FUNCTION session_turn_attempt_propagate_quiescence_hint();

UPDATE session_attempt_interruptions interruption
SET attempt_quiesced = true
FROM session_turn_attempts attempt
WHERE attempt.workspace_id = interruption.workspace_id
  AND attempt.id = interruption.attempt_id
  AND attempt.quiesced_at IS NOT NULL
  AND NOT interruption.attempt_quiesced;

-- The table holds one row per interruption ever requested (thousands, not
-- millions), so a transactional build is brief.
CREATE INDEX session_attempt_interruptions_open_settlement_idx
  ON session_attempt_interruptions (workspace_id, session_id)
  WHERE state IN ('pending', 'delivered', 'acknowledged') OR NOT attempt_quiesced;
