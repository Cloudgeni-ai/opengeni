-- deployment-mode: rolling
-- Expose one content-free, bounded-cardinality aggregate for durable recovery
-- states that process-local turn gauges cannot see.

CREATE OR REPLACE FUNCTION opengeni_private.count_session_recovery_backlog()
RETURNS TABLE (state text, count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path FROM CURRENT
AS $count_session_recovery_backlog$
  WITH recovery_states(state) AS (
    VALUES ('quiescence_missing'::text), ('projection_stale'::text)
  ), candidates AS (
    SELECT CASE
      WHEN attempt.quiesced_at IS NULL THEN 'quiescence_missing'::text
      ELSE 'projection_stale'::text
    END AS state
    FROM sessions session
    JOIN session_turns turn
      ON turn.workspace_id = session.workspace_id
     AND turn.session_id = session.id
     AND turn.id = session.active_turn_id
    JOIN LATERAL (
      SELECT candidate.id, candidate.state, candidate.outcome, candidate.quiesced_at
      FROM session_turn_attempts candidate
      WHERE candidate.workspace_id = turn.workspace_id
        AND candidate.session_id = turn.session_id
        AND candidate.turn_id = turn.id
      ORDER BY candidate.execution_generation DESC, candidate.updated_at DESC, candidate.id DESC
      LIMIT 1
    ) attempt ON true
    WHERE session.status = 'recovering'
      AND turn.status = 'recovering'
      AND turn.active_attempt_id IS NULL
      AND attempt.state = 'closed'
      AND attempt.outcome = 'interrupted_recoverable'
      AND (
        EXISTS (
          SELECT 1
          FROM session_attempt_interruptions interruption
          WHERE interruption.workspace_id = session.workspace_id
            AND interruption.session_id = session.id
            AND interruption.attempt_id = attempt.id
            AND interruption.state IN ('settled', 'rejected_stale')
        )
        OR EXISTS (
          SELECT 1
          FROM session_events event
          WHERE event.workspace_id = session.workspace_id
            AND event.session_id = session.id
            AND event.turn_id = turn.id
            AND event.turn_attempt_id = attempt.id
            AND event.type = 'turn.recovery.requested'
        )
      )
  )
  SELECT recovery_states.state, count(candidates.state)::bigint
  FROM recovery_states
  LEFT JOIN candidates USING (state)
  GROUP BY recovery_states.state
  ORDER BY recovery_states.state;
$count_session_recovery_backlog$;

REVOKE ALL ON FUNCTION opengeni_private.count_session_recovery_backlog() FROM PUBLIC;

DO $session_recovery_observability_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.count_session_recovery_backlog() TO opengeni_app;
  END IF;
END
$session_recovery_observability_grants$;
