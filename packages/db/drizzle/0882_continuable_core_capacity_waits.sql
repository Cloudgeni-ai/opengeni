-- deployment-mode: rolling
-- Resume (session and workspace) and maintenance reconstruction register a
-- fresh workflow wake only for sessions that list_continuable_sessions reports.
-- Its capacity reason still read only the legacy Codex waiter table, so a
-- session paused while waiting on the shared subscription core's capacity
-- waiter (every provider since its cutover) was resumed without a wake. Its
-- workflow had closed under Pause, so the turn stayed `waiting_capacity` until
-- some unrelated capacity change happened to wake it, possibly never.
--
-- The capacity reason now mirrors peekSessionWork: any core waiter row for the
-- session (a waiter that no longer matches its turn is an immediate check whose
-- reconcile deletes it) or an active turn still `waiting_capacity` (runnable).
-- The legacy waiter clause is kept. Signature, ownership and grants are
-- unchanged for rolling compatibility.
--
-- Sessions that are unblocked now and were already resumed without that wake
-- get one fresh wake, so they recheck capacity instead of waiting forever.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $continuability$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.list_continuable_sessions(
      p_workspace_id uuid,
      p_root_session_id uuid
    )
    RETURNS TABLE (
      account_id uuid,
      workspace_id uuid,
      session_id uuid,
      temporal_workflow_id text,
      reasons text[]
    )
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog
    AS $function$
      WITH RECURSIVE control_tree AS (
        SELECT session.workspace_id, session.id, session.parent_session_id,
               greatest(control.workspace_pause_revision, session.direct_pause_revision)
                 AS max_pause_revision,
               session.subtree_run_override_revision AS max_override_revision,
               0::integer AS depth
        FROM %1$I.sessions session
        JOIN %1$I.workspace_inference_controls control
          ON control.workspace_id = session.workspace_id
        WHERE session.parent_session_id IS NULL
          AND (p_workspace_id IS NULL OR session.workspace_id = p_workspace_id)
        UNION ALL
        SELECT child.workspace_id, child.id, child.parent_session_id,
               greatest(parent.max_pause_revision, child.direct_pause_revision),
               greatest(parent.max_override_revision, child.subtree_run_override_revision),
               parent.depth + 1
        FROM control_tree parent
        JOIN %1$I.sessions child
          ON child.workspace_id = parent.workspace_id
         AND child.parent_session_id = parent.id
        WHERE parent.depth < 10000
      ), descendants AS (
        SELECT tree.workspace_id, tree.id
        FROM control_tree tree
        WHERE p_root_session_id IS NOT NULL AND tree.id = p_root_session_id
        UNION ALL
        SELECT child.workspace_id, child.id
        FROM descendants parent
        JOIN control_tree child
          ON child.workspace_id = parent.workspace_id
         AND child.parent_session_id = parent.id
      ), scope_sessions AS (
        SELECT session.*, tree.max_pause_revision, tree.max_override_revision
        FROM %1$I.sessions session
        JOIN control_tree tree
          ON tree.workspace_id = session.workspace_id AND tree.id = session.id
        WHERE (
            p_root_session_id IS NULL
            OR EXISTS (
              SELECT 1 FROM descendants descendant
              WHERE descendant.workspace_id = session.workspace_id
                AND descendant.id = session.id
            )
          )
      ), control_state AS (
        SELECT session.workspace_id, session.id AS session_id,
               session.max_pause_revision IS NOT NULL
                 AND (
                   session.max_override_revision IS NULL
                   OR session.max_pause_revision >= session.max_override_revision
                 ) AS blocked
        FROM scope_sessions session
      ), unsettled_interruptions AS (
        SELECT DISTINCT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        JOIN %1$I.session_attempt_interruptions interruption
          ON interruption.workspace_id = session.workspace_id
         AND interruption.session_id = session.id
        WHERE interruption.state IN ('pending', 'delivered', 'acknowledged')
      ), queued_human AS (
        SELECT DISTINCT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        JOIN %1$I.session_turns turn
          ON turn.workspace_id = session.workspace_id AND turn.session_id = session.id
        WHERE turn.status = 'queued' AND turn.source IN ('user', 'api')
      ), recovering_turn AS (
        SELECT DISTINCT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        JOIN %1$I.session_turns turn
          ON turn.workspace_id = session.workspace_id
         AND turn.session_id = session.id
         AND turn.id = session.active_turn_id
        WHERE turn.status = 'recovering'
      ), capacity_wait AS (
        SELECT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        WHERE EXISTS (
            SELECT 1 FROM %1$I.codex_capacity_waiters waiter
            WHERE waiter.workspace_id = session.workspace_id
              AND waiter.session_id = session.id
              AND waiter.status = 'waiting'
          )
          OR EXISTS (
            SELECT 1 FROM %1$I.subscription_capacity_waiters waiter
            WHERE waiter.workspace_id = session.workspace_id
              AND waiter.session_id = session.id
          )
          OR EXISTS (
            SELECT 1 FROM %1$I.session_turns turn
            WHERE turn.workspace_id = session.workspace_id
              AND turn.session_id = session.id
              AND turn.id = session.active_turn_id
              AND turn.status = 'waiting_capacity'
          )
      ), decided_approval AS (
        SELECT DISTINCT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        JOIN %1$I.session_turns turn
          ON turn.workspace_id = session.workspace_id
         AND turn.session_id = session.id
         AND turn.id = session.active_turn_id
        JOIN %1$I.session_events trigger_event
          ON trigger_event.workspace_id = turn.workspace_id
         AND trigger_event.id = turn.trigger_event_id
        JOIN %1$I.session_events decision
          ON decision.workspace_id = turn.workspace_id
         AND decision.session_id = turn.session_id
         AND decision.sequence > trigger_event.sequence
         AND decision.type = 'user.approvalDecision'
        WHERE turn.status = 'requires_action'
      ), active_goal AS (
        SELECT DISTINCT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        JOIN %1$I.session_goals goal
          ON goal.workspace_id = session.workspace_id AND goal.session_id = session.id
        WHERE goal.status = 'active'
      ), pending_internal_updates AS (
        SELECT DISTINCT session.workspace_id, session.id AS session_id
        FROM scope_sessions session
        JOIN %1$I.session_system_updates update_row
          ON update_row.workspace_id = session.workspace_id
         AND update_row.session_id = session.id
        WHERE update_row.state = 'pending'
      ), classified AS (
        SELECT session.account_id, session.workspace_id, session.id AS session_id,
               coalesce(session.temporal_workflow_id, 'session-' || session.id::text)
                 AS temporal_workflow_id,
               array_remove(ARRAY[
                 CASE WHEN interruption.session_id IS NOT NULL
                   THEN 'interruption_settlement' END,
                 CASE WHEN NOT control.blocked AND queued.session_id IS NOT NULL
                   THEN 'queued_human' END,
                 CASE WHEN NOT control.blocked AND recovering.session_id IS NOT NULL
                   THEN 'recovering_turn' END,
                 CASE WHEN NOT control.blocked AND capacity.session_id IS NOT NULL
                   THEN 'capacity_wait' END,
                 CASE WHEN NOT control.blocked AND approval.session_id IS NOT NULL
                   THEN 'decided_approval' END,
                 CASE WHEN NOT control.blocked AND goal.session_id IS NOT NULL
                   THEN 'active_goal' END,
                 CASE WHEN NOT control.blocked AND updates.session_id IS NOT NULL
                   THEN 'pending_internal_updates' END,
                 CASE WHEN NOT control.blocked AND session.compact_requested
                   THEN 'compaction_requested' END
               ]::text[], NULL) AS reasons
        FROM scope_sessions session
        JOIN control_state control
          ON control.workspace_id = session.workspace_id AND control.session_id = session.id
        LEFT JOIN unsettled_interruptions interruption
          ON interruption.workspace_id = session.workspace_id
         AND interruption.session_id = session.id
        LEFT JOIN queued_human queued
          ON queued.workspace_id = session.workspace_id AND queued.session_id = session.id
        LEFT JOIN recovering_turn recovering
          ON recovering.workspace_id = session.workspace_id AND recovering.session_id = session.id
        LEFT JOIN capacity_wait capacity
          ON capacity.workspace_id = session.workspace_id AND capacity.session_id = session.id
        LEFT JOIN decided_approval approval
          ON approval.workspace_id = session.workspace_id AND approval.session_id = session.id
        LEFT JOIN active_goal goal
          ON goal.workspace_id = session.workspace_id AND goal.session_id = session.id
        LEFT JOIN pending_internal_updates updates
          ON updates.workspace_id = session.workspace_id AND updates.session_id = session.id
      )
      SELECT classified.account_id, classified.workspace_id, classified.session_id,
             classified.temporal_workflow_id, classified.reasons
      FROM classified
      WHERE cardinality(classified.reasons) > 0
      ORDER BY classified.workspace_id, classified.session_id
    $function$;
  $create$, target_schema);
END $continuability$;

-- One wake for every capacity wait that the function above now reports for an
-- unblocked session and whose generic wake is not already pending. A waiter
-- with a live workflow just rechecks once; one whose workflow closed under
-- Pause before Resume starts a run that sees it due. Paused waits are left to
-- Resume. The control predicate is the function's own; only the tables this
-- repair reads get an owner-only window, restored to their exact prior state,
-- so the non-BYPASSRLS migrator sees every workspace.
CREATE TEMP TABLE capacity_wait_forced_tables ON COMMIT DROP AS
SELECT class.oid::regclass AS relation
FROM pg_class class
WHERE class.oid IN (
    'sessions'::regclass, 'session_turns'::regclass,
    'workspace_inference_controls'::regclass, 'codex_capacity_waiters'::regclass,
    'subscription_capacity_waiters'::regclass, 'session_workflow_wake_outbox'::regclass
  )
  AND class.relforcerowsecurity;

DO $open_capacity_wait_reads$
DECLARE forced regclass;
BEGIN
  FOR forced IN SELECT relation FROM capacity_wait_forced_tables ORDER BY relation::text LOOP
    EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', forced);
  END LOOP;
END $open_capacity_wait_reads$;

WITH RECURSIVE candidates AS (
  SELECT session.account_id, session.workspace_id, session.id,
         coalesce(session.temporal_workflow_id, 'session-' || session.id::text)
           AS temporal_workflow_id
  FROM sessions session
  WHERE EXISTS (
      SELECT 1 FROM codex_capacity_waiters waiter
      WHERE waiter.workspace_id = session.workspace_id
        AND waiter.session_id = session.id
        AND waiter.status = 'waiting'
    )
    OR EXISTS (
      SELECT 1 FROM subscription_capacity_waiters waiter
      WHERE waiter.workspace_id = session.workspace_id AND waiter.session_id = session.id
    )
    OR EXISTS (
      SELECT 1 FROM session_turns turn
      WHERE turn.workspace_id = session.workspace_id
        AND turn.session_id = session.id
        AND turn.id = session.active_turn_id
        AND turn.status = 'waiting_capacity'
    )
), ancestry AS (
  SELECT candidate.id AS target_id, session.workspace_id, session.parent_session_id,
         session.direct_pause_revision, session.subtree_run_override_revision,
         0::integer AS depth
  FROM candidates candidate
  JOIN sessions session
    ON session.workspace_id = candidate.workspace_id AND session.id = candidate.id
  UNION ALL
  SELECT child.target_id, parent.workspace_id, parent.parent_session_id,
         parent.direct_pause_revision, parent.subtree_run_override_revision,
         child.depth + 1
  FROM ancestry child
  JOIN sessions parent
    ON parent.workspace_id = child.workspace_id AND parent.id = child.parent_session_id
  WHERE child.depth < 10000
), path AS (
  SELECT target_id,
         max(direct_pause_revision) AS max_direct_pause_revision,
         max(subtree_run_override_revision) AS max_override_revision,
         bool_or(parent_session_id IS NULL) AS reached_root
  FROM ancestry
  GROUP BY target_id
), unblocked AS (
  SELECT candidate.*
  FROM candidates candidate
  JOIN path ON path.target_id = candidate.id
  JOIN workspace_inference_controls control
    ON control.workspace_id = candidate.workspace_id
  CROSS JOIN LATERAL (
    SELECT greatest(control.workspace_pause_revision, path.max_direct_pause_revision)
      AS max_pause_revision
  ) pause
  WHERE path.reached_root
    AND NOT (
      pause.max_pause_revision IS NOT NULL
      AND (
        path.max_override_revision IS NULL
        OR pause.max_pause_revision >= path.max_override_revision
      )
    )
)
INSERT INTO session_workflow_wake_outbox (
  session_id, account_id, workspace_id, temporal_workflow_id, reason
)
SELECT id, account_id, workspace_id, temporal_workflow_id, 'capacity_wait_repair'
FROM unblocked
ON CONFLICT (session_id) DO UPDATE SET
  wake_revision = session_workflow_wake_outbox.wake_revision + 1,
  temporal_workflow_id = excluded.temporal_workflow_id,
  reason = excluded.reason,
  attempts = 0,
  next_attempt_at = clock_timestamp(),
  last_error = NULL,
  updated_at = clock_timestamp()
WHERE session_workflow_wake_outbox.wake_revision <= session_workflow_wake_outbox.delivered_revision;

DO $close_capacity_wait_reads$
DECLARE forced regclass;
BEGIN
  FOR forced IN SELECT relation FROM capacity_wait_forced_tables ORDER BY relation::text LOOP
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', forced);
  END LOOP;
END $close_capacity_wait_reads$;
