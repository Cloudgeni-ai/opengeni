-- deployment-mode: rolling
-- `opengeni_turns_queued` counts every durable `session_turns` row with
-- status 'queued'. That is queue truth, but most of those prompts are not
-- waiting for a worker: they sit behind a running turn of the same session,
-- behind an effective Pause, behind a failed turn (the queue resumes on the
-- next message), or behind a required human action. On staging the count sat
-- at about 436 for weeks while the eligible Temporal backlog was 0, and a
-- dashboard reading it as backlog looked like stuck capacity.
--
-- Add one content-free, bounded-cardinality summary that classifies each
-- queued turn by what currently holds it, using the session's own durable
-- state, with the oldest queued age per class. `ready` means nothing in the
-- session state holds the prompt; it should be claimed within seconds, so an
-- old `ready` prompt is a stranded queue worth investigating. The effective
-- pause algebra (own pause, undefeated ancestor pause, undefeated workspace
-- pause) matches 0519 and packages/db/src/session-control.ts.
--
-- Precedence when several holds apply: paused, failed, requires_action,
-- waiting_capacity, cancelled, behind_active_turn, ready. The existing
-- count_queued_turns() is unchanged, so pre-0988 workers keep working.
--
-- The pause check is evaluated once per candidate session, never per queued
-- turn: a running maximum over each ancestry path finds the newest
-- descendant-side override for every pause row, and the workspace pause uses a
-- single anti-join. Failed sessions keep their queues indefinitely, so the
-- cost must stay near linear in the backlog.
--
-- The function is created with its runtime EXECUTE withheld for one release
-- (runtime-posture DEFERRED_RUNTIME_PRIVATE_ROUTINES): the previous release
-- does not know it and rejects a runtime grant on an unknown SECURITY DEFINER
-- routine. Until a later migration grants it, the control worker checks the
-- grant first and does not publish the split.

CREATE FUNCTION opengeni_private.summarize_queued_turns_by_hold()
RETURNS TABLE (
  hold text,
  count bigint,
  oldest_age_seconds double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path FROM CURRENT
AS $summarize_queued_turns_by_hold$
  WITH RECURSIVE holds(hold) AS (
    VALUES
      ('ready'::text),
      ('behind_active_turn'::text),
      ('paused'::text),
      ('failed'::text),
      ('requires_action'::text),
      ('waiting_capacity'::text),
      ('cancelled'::text)
  ), queued AS (
    SELECT turn.workspace_id, turn.session_id, turn.created_at
    FROM session_turns turn
    WHERE turn.status = 'queued'
  ), candidate_sessions AS (
    SELECT DISTINCT
      session.workspace_id,
      session.id AS session_id,
      session.status,
      session.active_turn_id
    FROM queued
    JOIN sessions session
      ON session.workspace_id = queued.workspace_id
     AND session.id = queued.session_id
  ), ancestry AS (
    -- Bound and cycle guard match the canonical effective-control algebra.
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
    FROM candidate_sessions candidate
    JOIN sessions session_row
      ON session_row.workspace_id = candidate.workspace_id
     AND session_row.id = candidate.session_id
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
  ), ancestry_overrides AS (
    -- Newest override on a strictly deeper (descendant-side) row of the path.
    SELECT
      path_row.*,
      max(path_row.subtree_run_override_revision) OVER (
        PARTITION BY path_row.candidate_session_id
        ORDER BY path_row.depth
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ) AS descendant_override_revision
    FROM ancestry path_row
  ), effectively_paused AS MATERIALIZED (
    -- A session pause is defeated only by a strictly newer override on a
    -- strictly deeper (descendant-side) path row.
    SELECT pause.candidate_session_id AS session_id
    FROM ancestry_overrides pause
    WHERE NOT pause.cycle
      AND pause.direct_control_state = 'paused'
      AND pause.direct_pause_revision IS NOT NULL
      AND (
        pause.descendant_override_revision IS NULL
        OR pause.descendant_override_revision <= pause.direct_pause_revision
      )
    UNION
    -- A workspace pause is defeated by any newer override on the path.
    SELECT candidate.session_id
    FROM candidate_sessions candidate
    JOIN workspace_inference_controls control_row
      ON control_row.workspace_id = candidate.workspace_id
     AND control_row.workspace_state = 'paused'
    WHERE NOT EXISTS (
      SELECT 1
      FROM ancestry override_row
      WHERE override_row.candidate_session_id = candidate.session_id
        AND control_row.workspace_pause_revision IS NOT NULL
        AND override_row.subtree_run_override_revision > control_row.workspace_pause_revision
    )
  ), classified AS (
    SELECT
      CASE
        WHEN paused.session_id IS NOT NULL THEN 'paused'::text
        WHEN candidate.status = 'failed' THEN 'failed'::text
        WHEN candidate.status = 'requires_action' THEN 'requires_action'::text
        WHEN candidate.status = 'waiting_capacity' THEN 'waiting_capacity'::text
        WHEN candidate.status = 'cancelled' THEN 'cancelled'::text
        WHEN candidate.active_turn_id IS NOT NULL
          OR candidate.status IN ('running', 'recovering') THEN 'behind_active_turn'::text
        ELSE 'ready'::text
      END AS hold,
      queued.created_at
    FROM queued
    JOIN candidate_sessions candidate
      ON candidate.workspace_id = queued.workspace_id
     AND candidate.session_id = queued.session_id
    LEFT JOIN effectively_paused paused
      ON paused.session_id = candidate.session_id
  )
  SELECT
    holds.hold,
    count(classified.hold)::bigint,
    COALESCE(
      GREATEST(0, EXTRACT(EPOCH FROM (now() - min(classified.created_at)))),
      0
    )::double precision
  FROM holds
  LEFT JOIN classified USING (hold)
  GROUP BY holds.hold
  ORDER BY holds.hold;
$summarize_queued_turns_by_hold$;

REVOKE ALL ON FUNCTION opengeni_private.summarize_queued_turns_by_hold() FROM PUBLIC;
