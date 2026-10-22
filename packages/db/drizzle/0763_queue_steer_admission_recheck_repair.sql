-- deployment-mode: rolling
-- Queue-row Steer used to queue an explicit replacement and commit its wake
-- without clearing the earlier pre-claim admission block. Peek and claim
-- still refused the blocked session, and wake delivery acknowledged the wake,
-- leaving no runnable path to this accepted direction.
--
-- Repair only a still-current, applied human queue Steer AFTER the retained
-- block: exact receipt, target version, queue version and last event. A newer
-- rejection, queue edit, successor attempt or session transition wins. No
-- authority is granted; the ordinary claim revalidates it and may block again.
-- Paused recoveries and capacity waits are resumable obligations, not abandoned
-- work; neither their turns nor their closed attempts should be terminalized.
-- There is no age-based replay or cancellation and no history rewrite.
--
-- Owner-only windows make the reads visible to the non-BYPASSRLS migrator.
-- Table locks exclude writers. Disable only the session's advisory-fence
-- assertion during its update; never acquire advisory locks after table locks.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turns NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turn_attempts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_command_receipts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_workflow_wake_outbox NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_session_activity_revisions NO FORCE ROW LEVEL SECURITY;

CREATE TEMP TABLE queue_steer_admission_rechecks ON COMMIT DROP AS
SELECT DISTINCT session.id, session.account_id, session.workspace_id,
  coalesce(session.temporal_workflow_id, 'session-' || session.id::text) AS workflow_id
FROM sessions session
JOIN session_command_receipts receipt
  ON receipt.account_id = session.account_id
 AND receipt.workspace_id = session.workspace_id
 AND receipt.target_session_id = session.id
 AND receipt.action = 'queue.steer'
 AND receipt.actor_type = 'human'
 AND receipt.applied_queue_version = session.queue_version
JOIN session_turns target
  ON target.workspace_id = receipt.workspace_id
 AND target.session_id = session.id
 AND target.id = receipt.target_turn_id
 AND target.version = receipt.applied_turn_version
 AND target.status = 'queued'
 AND target.active_attempt_id IS NULL
 AND target.metadata ->> 'delivery' = 'steer'
JOIN session_events event
  ON event.workspace_id = session.workspace_id
 AND event.session_id = session.id
 AND event.sequence = session.last_sequence
 AND event.type = 'session.control.steer_requested'
 AND event.payload ->> 'operationId' = receipt.id::text
 AND event.payload ->> 'targetTurnId' = target.id::text
WHERE session.status = 'queued'
  AND session.active_turn_id IS NULL
  AND session.imported_archive_import_id IS NULL
  AND session.content_archive_state IS NULL
  AND session.admission_block IS NOT NULL
  AND session.admission_block ->> 'retryPolicy' = 'explicit_recheck'
  -- Compare the canonical ISO timestamp as text, avoiding a cast of legacy
  -- JSON. A missing/malformed block timestamp is not recovery authority.
  AND session.admission_block ->> 'blockedAt'
    ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
  AND to_char(event.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    > session.admission_block ->> 'blockedAt'
  AND NOT EXISTS (
    SELECT 1 FROM session_turn_attempts attempt
    WHERE attempt.workspace_id = session.workspace_id
      AND attempt.session_id = session.id
      AND (attempt.state <> 'closed' OR attempt.started_at >= event.occurred_at)
  );

INSERT INTO session_workflow_wake_outbox (
  session_id, account_id, workspace_id, temporal_workflow_id, reason, control_revision
)
SELECT id, account_id, workspace_id, workflow_id, 'queue_steer_recheck_repair', 1
FROM queue_steer_admission_rechecks
ON CONFLICT (session_id) DO UPDATE SET
  wake_revision = session_workflow_wake_outbox.wake_revision + 1,
  control_revision = session_workflow_wake_outbox.wake_revision + 1,
  reason = excluded.reason,
  next_attempt_at = clock_timestamp(), attempts = 0, last_error = NULL,
  updated_at = clock_timestamp();

ALTER TABLE sessions DISABLE TRIGGER session_tenancy_workspace_fence;
-- Preserve normal incremental-list invalidation, without disabling the
-- activity guards. Resolve deferred obligations before advancing each
-- workspace clock; session rows are already exclusively owned by this repair.
DO $repair_session_activity$
DECLARE
  repaired_workspace uuid;
  next_activity_revision bigint;
BEGIN
  FOR repaired_workspace IN
    SELECT DISTINCT workspace_id FROM queue_steer_admission_rechecks ORDER BY workspace_id
  LOOP
    SET CONSTRAINTS sessions_activity_insert_commit_guard, sessions_activity_update_commit_guard DEFERRED;
    PERFORM set_config('opengeni.session_activity_gate_workspace_id', repaired_workspace::text, true);
    PERFORM set_config('opengeni.session_activity_gate_state', 'open', true);
    UPDATE sessions session SET admission_block = NULL, updated_at = clock_timestamp()
    FROM queue_steer_admission_rechecks repair
    WHERE session.id = repair.id AND repair.workspace_id = repaired_workspace;

    PERFORM set_config('opengeni.session_activity_gate_state', 'preparing', true);
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS sessions_activity_insert_commit_guard, sessions_activity_update_commit_guard DEFERRED;
    PERFORM set_config('opengeni.session_activity_gate_state', 'finalizing', true);
    UPDATE workspace_session_activity_revisions counter SET revision = counter.revision + 1
    WHERE counter.workspace_id = repaired_workspace
    RETURNING revision INTO STRICT next_activity_revision;
    UPDATE sessions session SET activity_revision = next_activity_revision,
      activity_revision_pending_xid = NULL
    WHERE session.workspace_id = repaired_workspace
      AND session.activity_revision_pending_xid = pg_current_xact_id()::text::bigint;
    PERFORM set_config('opengeni.session_activity_gate_state', 'finalized', true);
    SET CONSTRAINTS ALL IMMEDIATE;
  END LOOP;
  PERFORM set_config('opengeni.session_activity_gate_state', '', true);
  PERFORM set_config('opengeni.session_activity_gate_workspace_id', '', true);
END $repair_session_activity$;
ALTER TABLE sessions ENABLE TRIGGER session_tenancy_workspace_fence;

DO $verify_queue_steer_recheck$
BEGIN
  IF EXISTS (
    SELECT 1 FROM queue_steer_admission_rechecks repair
    JOIN sessions session ON session.id = repair.id
    LEFT JOIN session_workflow_wake_outbox wake ON wake.session_id = repair.id
    WHERE session.admission_block IS NOT NULL OR wake.session_id IS NULL
      OR wake.wake_revision <= wake.delivered_revision
  ) THEN
    RAISE EXCEPTION 'queue Steer admission recheck repair did not converge';
  END IF;
END $verify_queue_steer_recheck$;

ALTER TABLE workspace_session_activity_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE session_workflow_wake_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE session_events FORCE ROW LEVEL SECURITY;
ALTER TABLE session_command_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turn_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turns FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
