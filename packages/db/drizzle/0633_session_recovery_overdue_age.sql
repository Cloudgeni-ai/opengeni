-- deployment-mode: rolling
-- The recovery backlog counts every session between recovery attempts,
-- including sessions legitimately sleeping in their recorded same-turn backoff
-- (provider Retry-After, which is unbounded by design, or the 2/5/15/30/60 s
-- connectivity pacing). Under sustained provider 429s some session is always
-- in backoff, so "backlog > 0 for 10 minutes" paged although each session was
-- re-claimed within seconds of its due time.
--
-- Add one content-free, bounded-cardinality summary that also reports, per
-- state, how many candidates are still inside their recorded backoff and how
-- long the single oldest candidate has been past its due time. A recovery is
-- due at its exact attempt's close plus the continueDelayMs that the same
-- transaction recorded on that attempt's turn.recovery.requested event (zero
-- when the recovery recorded no delay: worker shutdown/loss, interruption
-- settlement). quiescence_missing is not paced by backoff - the closing
-- activity owes its receipt immediately - so it is due at the close. Candidate
-- selection is exactly 0519's, so the backlog count itself is unchanged.
--
-- count_session_recovery_backlog() keeps its signature for pre-0633 workers
-- during the rolling deploy and now projects this summary, so both readers
-- share one definition.

CREATE OR REPLACE FUNCTION opengeni_private.summarize_session_recovery_backlog()
RETURNS TABLE (
  state text,
  count bigint,
  scheduled bigint,
  oldest_overdue_seconds double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path FROM CURRENT
AS $summarize_session_recovery_backlog$
  WITH RECURSIVE recovery_states(state) AS (
    VALUES ('quiescence_missing'::text), ('projection_stale'::text)
  ), recovering AS (
    SELECT
      session.workspace_id,
      session.id AS session_id,
      attempt.quiesced_at,
      coalesce(attempt.closed_at, attempt.updated_at) AS closed_at,
      coalesce(recovery_delay.delay_ms, 0) AS delay_ms
    FROM sessions session
    JOIN session_turns turn
      ON turn.workspace_id = session.workspace_id
     AND turn.session_id = session.id
     AND turn.id = session.active_turn_id
    JOIN LATERAL (
      SELECT
        candidate.id,
        candidate.state,
        candidate.outcome,
        candidate.quiesced_at,
        candidate.closed_at,
        candidate.updated_at
      FROM session_turn_attempts candidate
      WHERE candidate.workspace_id = turn.workspace_id
        AND candidate.session_id = turn.session_id
        AND candidate.turn_id = turn.id
      ORDER BY candidate.execution_generation DESC, candidate.updated_at DESC, candidate.id DESC
      LIMIT 1
    ) attempt ON true
    LEFT JOIN LATERAL (
      -- Only the numeric pacing scalar is read. The nested CASE guarantees the
      -- cast sees a JSON number; the bound keeps a malformed value from
      -- overflowing the interval arithmetic below. A non-null result (even 0)
      -- also proves the recovery request exists.
      SELECT CASE
        WHEN jsonb_typeof(event.payload -> 'continueDelayMs') = 'number'
        THEN greatest(
          0::numeric,
          least((event.payload ->> 'continueDelayMs')::numeric, 1000000000000::numeric)
        )
        ELSE 0::numeric
      END AS delay_ms
      FROM session_events event
      WHERE event.workspace_id = session.workspace_id
        AND event.session_id = session.id
        AND event.turn_id = turn.id
        AND event.turn_attempt_id = attempt.id
        AND event.type = 'turn.recovery.requested'
      ORDER BY event.sequence DESC
      LIMIT 1
    ) recovery_delay ON true
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
        OR recovery_delay.delay_ms IS NOT NULL
      )
  ), ancestry AS (
    -- Walk only projection candidates; the bound and cycle guard match the
    -- canonical effective-control algebra (packages/db/src/session-control.ts).
    SELECT
      candidate.session_id AS candidate_session_id,
      session_row.workspace_id,
      session_row.parent_session_id,
      session_row.direct_control_state,
      session_row.direct_pause_revision,
      session_row.subtree_run_override_revision,
      0::integer AS depth,
      ARRAY[session_row.id]::uuid[] AS path,
      false AS cycle
    FROM recovering candidate
    JOIN sessions session_row
      ON session_row.workspace_id = candidate.workspace_id
     AND session_row.id = candidate.session_id
    WHERE candidate.quiesced_at IS NOT NULL
    UNION ALL
    SELECT
      child.candidate_session_id,
      parent.workspace_id,
      parent.parent_session_id,
      parent.direct_control_state,
      parent.direct_pause_revision,
      parent.subtree_run_override_revision,
      child.depth + 1,
      child.path || parent.id,
      parent.id = ANY(child.path)
    FROM ancestry child
    JOIN sessions parent
      ON parent.workspace_id = child.workspace_id
     AND parent.id = child.parent_session_id
    WHERE child.parent_session_id IS NOT NULL
      AND NOT child.cycle
      AND child.depth < 10000
  ), effectively_paused AS (
    SELECT candidate.session_id
    FROM recovering candidate
    WHERE candidate.quiesced_at IS NOT NULL
      AND (
        -- A session pause is defeated only by a strictly newer override on a
        -- strictly deeper (descendant-side) path row.
        EXISTS (
          SELECT 1
          FROM ancestry pause
          WHERE pause.candidate_session_id = candidate.session_id
            AND NOT pause.cycle
            AND pause.direct_control_state = 'paused'
            AND pause.direct_pause_revision IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM ancestry override_row
              WHERE override_row.candidate_session_id = candidate.session_id
                AND override_row.depth < pause.depth
                AND override_row.subtree_run_override_revision > pause.direct_pause_revision
            )
        )
        -- A workspace pause is defeated by any newer override on the path.
        OR EXISTS (
          SELECT 1
          FROM workspace_inference_controls control_row
          WHERE control_row.workspace_id = candidate.workspace_id
            AND control_row.workspace_state = 'paused'
            AND NOT EXISTS (
              SELECT 1
              FROM ancestry override_row
              WHERE override_row.candidate_session_id = candidate.session_id
                AND control_row.workspace_pause_revision IS NOT NULL
                AND override_row.subtree_run_override_revision
                  > control_row.workspace_pause_revision
            )
        )
      )
  ), candidates AS (
    SELECT
      due.state,
      due.due_at
    FROM recovering candidate
    CROSS JOIN LATERAL (
      SELECT
        CASE
          WHEN candidate.quiesced_at IS NULL THEN 'quiescence_missing'::text
          ELSE 'projection_stale'::text
        END AS state,
        CASE
          WHEN candidate.quiesced_at IS NULL THEN candidate.closed_at
          ELSE candidate.closed_at + candidate.delay_ms::double precision * interval '1 millisecond'
        END AS due_at
    ) due
    WHERE candidate.quiesced_at IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM effectively_paused paused
        WHERE paused.session_id = candidate.session_id
      )
  )
  SELECT
    recovery_states.state,
    count(candidates.state)::bigint,
    count(candidates.state) FILTER (WHERE candidates.due_at > now())::bigint,
    coalesce(
      max(extract(epoch FROM now() - candidates.due_at)) FILTER (WHERE candidates.due_at <= now()),
      0
    )::double precision
  FROM recovery_states
  LEFT JOIN candidates USING (state)
  GROUP BY recovery_states.state
  ORDER BY recovery_states.state;
$summarize_session_recovery_backlog$;

REVOKE ALL ON FUNCTION opengeni_private.summarize_session_recovery_backlog() FROM PUBLIC;

CREATE OR REPLACE FUNCTION opengeni_private.count_session_recovery_backlog()
RETURNS TABLE (state text, count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path FROM CURRENT
AS $count_session_recovery_backlog$
  SELECT summary.state, summary.count
  FROM opengeni_private.summarize_session_recovery_backlog() summary
  ORDER BY summary.state;
$count_session_recovery_backlog$;

REVOKE ALL ON FUNCTION opengeni_private.count_session_recovery_backlog() FROM PUBLIC;

DO $session_recovery_overdue_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.summarize_session_recovery_backlog() TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.count_session_recovery_backlog() TO opengeni_app;
  END IF;
END
$session_recovery_overdue_grants$;
