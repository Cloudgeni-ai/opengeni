-- deployment-mode: rolling
-- A turn activity could previously exhaust a transient attempt-claim failure,
-- leave the logical turn queued or recovering with no active attempt, and then
-- let its Temporal workflow complete. Seed one delayed durable wake for those
-- exact rows; current workflows may consume it as an idempotent hint, while
-- closed workflows are restarted by the ordinary outbox dispatcher. A normal
-- queued turn with an undelivered wake is healthy and must remain untouched.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

WITH orphaned AS (
  SELECT
    session_row.id AS session_id,
    session_row.account_id,
    session_row.workspace_id,
    coalesce(
      session_row.temporal_workflow_id,
      'session-' || session_row.id::text
    ) AS temporal_workflow_id
  FROM sessions session_row
  WHERE (
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
        session_row.status = 'queued'
        AND EXISTS (
          SELECT 1
          FROM workspace_inference_controls control_row
          WHERE control_row.workspace_id = session_row.workspace_id
            AND control_row.workspace_state = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM session_turns turn_row
          WHERE turn_row.workspace_id = session_row.workspace_id
            AND turn_row.session_id = session_row.id
            AND turn_row.status = 'queued'
            AND turn_row.active_attempt_id IS NULL
        )
        AND EXISTS (
          SELECT 1
          FROM session_workflow_wake_outbox wake_row
          WHERE wake_row.session_id = session_row.id
            AND wake_row.wake_revision > 0
            AND wake_row.wake_revision = wake_row.delivered_revision
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
