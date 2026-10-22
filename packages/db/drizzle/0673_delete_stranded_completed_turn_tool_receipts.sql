-- deployment-mode: rolling
-- Completed turns now consume their settled session_pending_tool_calls
-- receipts at settlement. This removes receipts that earlier releases left
-- behind on completed turns, with the same predicate. Such a receipt is stranded: its turn completed and
-- its attempt settled (closed, and either quiesced or never interrupted), so no
-- resume, Retry or recovery path can use it. Left in place, it reads as
-- unresolved work to tenancy quiescence, the Retry recovery preview and
-- native-origin recovery. A receipt whose attempt is still open or still owes
-- an interruption quiescence receipt is live and is kept.
--
-- Owner-only posture window: every table read or written here is FORCE RLS
-- and the migration principal sets no tenant GUC. The receipt table also
-- carries the session tenancy fence trigger, so each workspace's delete runs
-- while this backend holds that workspace's shared tenancy fence, released
-- after its delete so the lock count stays bounded. The ALTER TABLE statements
-- hold ACCESS EXCLUSIVE on these hot tables for the short delete loop, as the
-- 0499 cleanup did.
ALTER TABLE session_pending_tool_calls NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turns NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turn_attempts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_attempt_interruptions" NO FORCE ROW LEVEL SECURITY;

DO $stranded_receipts$
DECLARE
  target_workspace uuid;
  fence_key bigint;
BEGIN
  FOR target_workspace IN
    SELECT DISTINCT pending.workspace_id
    FROM session_pending_tool_calls pending
    JOIN session_turns owner_turn
      ON owner_turn.workspace_id = pending.workspace_id AND owner_turn.id = pending.turn_id
    WHERE owner_turn.status = 'completed'
  LOOP
    fence_key := hashtextextended('session-tenancy:' || target_workspace::text, 0);
    PERFORM pg_advisory_lock_shared(fence_key);
    BEGIN
      DELETE FROM session_pending_tool_calls pending
      USING session_turns owner_turn
      WHERE pending.workspace_id = target_workspace
        AND owner_turn.workspace_id = pending.workspace_id
        AND owner_turn.id = pending.turn_id
        AND owner_turn.status = 'completed'
        AND NOT EXISTS (
          SELECT 1 FROM session_turn_attempts owner_attempt
          WHERE owner_attempt.workspace_id = pending.workspace_id
            AND owner_attempt.id = pending.attempt_id
            AND (owner_attempt.state <> 'closed'
              OR (owner_attempt.quiesced_at IS NULL AND EXISTS (
                SELECT 1 FROM session_attempt_interruptions interruption
                WHERE interruption.attempt_id = owner_attempt.id))));
    EXCEPTION WHEN OTHERS THEN
      -- A session-level fence survives the rollback; release it before failing.
      PERFORM pg_advisory_unlock_shared(fence_key);
      RAISE;
    END;
    PERFORM pg_advisory_unlock_shared(fence_key);
  END LOOP;
END
$stranded_receipts$;

ALTER TABLE session_pending_tool_calls FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turns FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turn_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_attempt_interruptions" FORCE ROW LEVEL SECURITY;
