-- deployment-mode: rolling
-- A turn activity could previously exhaust a transient attempt-claim failure,
-- leave durable work with no active attempt, and then let its Temporal workflow
-- complete. This includes queued/recovering turns, a resumed approval, a
-- released capacity wait, manual compaction, and pending internal updates. Seed
-- one delayed durable wake for those exact admitted rows; current workflows may
-- consume it as an idempotent hint, while closed workflows are restarted by the
-- ordinary outbox dispatcher. A normal queued turn with an undelivered wake is
-- healthy and must remain untouched.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

WITH RECURSIVE candidates AS MATERIALIZED (
  SELECT
    session_row.id AS session_id,
    session_row.account_id,
    session_row.workspace_id,
    coalesce(
      session_row.temporal_workflow_id,
      'session-' || session_row.id::text
    ) AS temporal_workflow_id
  FROM sessions session_row
  WHERE session_row.status NOT IN ('failed', 'cancelled')
    AND NOT EXISTS (
      SELECT 1
      FROM session_turn_attempts live_attempt
      WHERE live_attempt.workspace_id = session_row.workspace_id
        AND live_attempt.session_id = session_row.id
        AND live_attempt.state IN ('claimed', 'running')
    )
    AND (
      (
        session_row.status = 'recovering'
        AND EXISTS (
          SELECT 1
          FROM session_turns turn_row
          WHERE turn_row.workspace_id = session_row.workspace_id
            AND turn_row.session_id = session_row.id
            AND turn_row.id = session_row.active_turn_id
            AND turn_row.status = 'recovering'
            AND turn_row.active_attempt_id IS NULL
        )
      )
      OR (
        EXISTS (
          SELECT 1
          FROM session_workflow_wake_outbox wake_row
          WHERE wake_row.session_id = session_row.id
            AND wake_row.wake_revision > 0
            AND wake_row.wake_revision = wake_row.delivered_revision
        )
        AND (
          (
            session_row.status = 'queued'
            AND session_row.active_turn_id IS NULL
            AND EXISTS (
              SELECT 1
              FROM session_turns turn_row
              WHERE turn_row.workspace_id = session_row.workspace_id
                AND turn_row.session_id = session_row.id
                AND turn_row.status = 'queued'
                AND turn_row.source IN ('user', 'api')
                AND turn_row.active_attempt_id IS NULL
            )
          )
          OR (
            session_row.status = 'waiting_capacity'
            AND EXISTS (
              SELECT 1
              FROM session_turns turn_row
              WHERE turn_row.workspace_id = session_row.workspace_id
                AND turn_row.session_id = session_row.id
                AND turn_row.id = session_row.active_turn_id
                AND turn_row.status = 'waiting_capacity'
                AND turn_row.active_attempt_id IS NULL
            )
            AND NOT EXISTS (
              SELECT 1
              FROM codex_capacity_waiters waiter
              WHERE waiter.workspace_id = session_row.workspace_id
                AND waiter.session_id = session_row.id
                AND waiter.status = 'waiting'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM xai_capacity_waiters waiter
              WHERE waiter.workspace_id = session_row.workspace_id
                AND waiter.session_id = session_row.id
                AND waiter.status = 'waiting'
            )
          )
          OR (
            session_row.status = 'requires_action'
            AND EXISTS (
              SELECT 1
              FROM session_turns turn_row
              JOIN session_events trigger_event
                ON trigger_event.workspace_id = turn_row.workspace_id
               AND trigger_event.session_id = turn_row.session_id
               AND trigger_event.id = turn_row.trigger_event_id
              WHERE turn_row.workspace_id = session_row.workspace_id
                AND turn_row.session_id = session_row.id
                AND turn_row.id = session_row.active_turn_id
                AND turn_row.status = 'requires_action'
                AND turn_row.active_attempt_id IS NULL
                AND EXISTS (
                  SELECT 1
                  FROM session_events response_event
                  WHERE response_event.workspace_id = session_row.workspace_id
                    AND response_event.session_id = session_row.id
                    AND response_event.type IN (
                      'user.approvalDecision',
                      'user.humanInputResponse'
                    )
                    AND response_event.sequence > trigger_event.sequence
                )
            )
          )
          OR (
            session_row.active_turn_id IS NULL
            AND session_row.status IN ('queued', 'idle')
            AND session_row.compact_requested
          )
          OR (
            session_row.active_turn_id IS NULL
            AND session_row.status IN ('queued', 'idle')
            AND EXISTS (
              SELECT 1
              FROM session_system_updates update_row
              WHERE update_row.workspace_id = session_row.workspace_id
                AND update_row.session_id = session_row.id
                AND update_row.state = 'pending'
            )
            AND (
              EXISTS (
                SELECT 1
                FROM session_system_updates update_row
                WHERE update_row.workspace_id = session_row.workspace_id
                  AND update_row.session_id = session_row.id
                  AND update_row.state = 'pending'
                  AND update_row.kind = 'agent_steer_instruction'
              )
              OR NOT EXISTS (
                SELECT 1
                FROM session_turns failed_turn
                JOIN session_events failure_event
                  ON failure_event.workspace_id = failed_turn.workspace_id
                 AND failure_event.session_id = failed_turn.session_id
                 AND failure_event.turn_id = failed_turn.id
                 AND failure_event.type = 'turn.failed'
                 AND failure_event.payload ->> 'code' = 'context_compaction_failed'
                WHERE failed_turn.workspace_id = session_row.workspace_id
                  AND failed_turn.session_id = session_row.id
                  AND failed_turn.finished_at IS NOT NULL
                  AND failed_turn.id = (
                    SELECT latest_turn.id
                    FROM session_turns latest_turn
                    WHERE latest_turn.workspace_id = session_row.workspace_id
                      AND latest_turn.session_id = session_row.id
                      AND latest_turn.finished_at IS NOT NULL
                    ORDER BY
                      latest_turn.position DESC,
                      latest_turn.created_at DESC
                    LIMIT 1
                  )
              )
            )
          )
        )
      )
    )
), ancestry AS (
  SELECT
    candidate.session_id AS candidate_session_id,
    session_row.workspace_id,
    session_row.id AS session_id,
    session_row.parent_session_id,
    session_row.direct_control_state,
    session_row.direct_pause_revision,
    session_row.subtree_run_override_revision,
    0::integer AS depth,
    ARRAY[session_row.id]::uuid[] AS path,
    false AS cycle
  FROM candidates candidate
  JOIN sessions session_row
    ON session_row.workspace_id = candidate.workspace_id
   AND session_row.id = candidate.session_id
  UNION ALL
  SELECT
    child.candidate_session_id,
    parent.workspace_id,
    parent.id,
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
), orphaned AS (
  SELECT candidate.*
  FROM candidates candidate
  JOIN workspace_inference_controls control_row
    ON control_row.workspace_id = candidate.workspace_id
  WHERE EXISTS (
      SELECT 1
      FROM ancestry root
      WHERE root.candidate_session_id = candidate.session_id
        AND root.parent_session_id IS NULL
        AND NOT root.cycle
    )
    AND NOT EXISTS (
      SELECT 1
      FROM ancestry invalid
      WHERE invalid.candidate_session_id = candidate.session_id
        AND invalid.cycle
    )
    AND NOT EXISTS (
      SELECT 1
      FROM ancestry pause
      WHERE pause.candidate_session_id = candidate.session_id
        AND pause.direct_control_state = 'paused'
        AND NOT EXISTS (
          SELECT 1
          FROM ancestry override_row
          WHERE override_row.candidate_session_id = candidate.session_id
            AND override_row.depth < pause.depth
            AND override_row.subtree_run_override_revision > pause.direct_pause_revision
        )
    )
    AND (
      control_row.workspace_state = 'active'
      OR (
        control_row.workspace_state = 'paused'
        AND EXISTS (
          SELECT 1
          FROM ancestry override_row
          WHERE override_row.candidate_session_id = candidate.session_id
            AND override_row.subtree_run_override_revision
              > control_row.workspace_pause_revision
        )
      )
    )
), seeded AS (
  INSERT INTO session_workflow_wake_outbox (
    session_id,
    account_id,
    workspace_id,
    temporal_workflow_id,
    reason,
    next_attempt_at
  )
  SELECT
    orphaned.session_id,
    orphaned.account_id,
    orphaned.workspace_id,
    orphaned.temporal_workflow_id,
    'unclaimed_attempt_recovery_cutover',
    now() + interval '60 seconds'
  FROM orphaned
  ON CONFLICT (session_id) DO UPDATE SET
    wake_revision = session_workflow_wake_outbox.wake_revision + 1,
    temporal_workflow_id = excluded.temporal_workflow_id,
    reason = excluded.reason,
    attempts = 0,
    next_attempt_at = CASE
      WHEN session_workflow_wake_outbox.wake_revision
        > session_workflow_wake_outbox.delivered_revision
        THEN least(
          session_workflow_wake_outbox.next_attempt_at,
          excluded.next_attempt_at
        )
      ELSE excluded.next_attempt_at
    END,
    last_error = NULL,
    updated_at = now()
  RETURNING account_id, workspace_id, session_id, wake_revision, reason
)
INSERT INTO audit_events (
  account_id,
  workspace_id,
  subject_id,
  action,
  target_type,
  target_id,
  metadata
)
SELECT
  seeded.account_id,
  seeded.workspace_id,
  'session-recovery-migration',
  'session.workflow.unclaimed_attempt_wake_seeded',
  'session',
  seeded.session_id::text,
  jsonb_build_object(
    'wakeRevision', seeded.wake_revision,
    'reason', seeded.reason
  )
FROM seeded;
