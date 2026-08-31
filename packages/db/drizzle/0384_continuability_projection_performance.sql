-- deployment-mode: rolling
-- Replace the canonical continuability projection without changing its result
-- contract. The original reason CTEs were each inlined beneath underestimated
-- nested-loop joins, so a 4,096-session workspace could rescan the same
-- materialized session scope tens of millions of times. Classify each session
-- once with bounded, index-backed EXISTS probes and materialize the ordered
-- reason array before filtering it.

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
        SELECT session.*,
               session.max_pause_revision IS NOT NULL
                 AND (
                   session.max_override_revision IS NULL
                   OR session.max_pause_revision >= session.max_override_revision
                 ) AS blocked
        FROM scope_sessions session
      ), classified AS MATERIALIZED (
        SELECT session.account_id, session.workspace_id, session.id AS session_id,
               coalesce(session.temporal_workflow_id, 'session-' || session.id::text)
                 AS temporal_workflow_id,
               array_remove(ARRAY[
                 CASE WHEN EXISTS (
                   SELECT 1
                   FROM %1$I.session_attempt_interruptions interruption
                   WHERE interruption.workspace_id = session.workspace_id
                     AND interruption.session_id = session.id
                     AND interruption.state IN ('pending', 'delivered', 'acknowledged')
                 ) THEN 'interruption_settlement' END,
                 CASE WHEN NOT session.blocked AND EXISTS (
                   SELECT 1
                   FROM %1$I.session_turns turn
                   WHERE turn.workspace_id = session.workspace_id
                     AND turn.session_id = session.id
                     AND turn.status = 'queued'
                     AND turn.source IN ('user', 'api')
                 ) THEN 'queued_human' END,
                 CASE WHEN NOT session.blocked AND EXISTS (
                   SELECT 1
                   FROM %1$I.session_turns turn
                   WHERE turn.workspace_id = session.workspace_id
                     AND turn.session_id = session.id
                     AND turn.id = session.active_turn_id
                     AND turn.status = 'recovering'
                 ) THEN 'recovering_turn' END,
                 CASE WHEN NOT session.blocked AND EXISTS (
                   SELECT 1
                   FROM %1$I.codex_capacity_waiters waiter
                   WHERE waiter.workspace_id = session.workspace_id
                     AND waiter.session_id = session.id
                     AND waiter.status = 'waiting'
                 ) THEN 'capacity_wait' END,
                 CASE WHEN NOT session.blocked AND EXISTS (
                   SELECT 1
                   FROM %1$I.session_turns turn
                   JOIN %1$I.session_events trigger_event
                     ON trigger_event.workspace_id = turn.workspace_id
                    AND trigger_event.id = turn.trigger_event_id
                   JOIN %1$I.session_events decision
                     ON decision.workspace_id = turn.workspace_id
                    AND decision.session_id = turn.session_id
                    AND decision.sequence > trigger_event.sequence
                    AND decision.type = 'user.approvalDecision'
                   WHERE turn.workspace_id = session.workspace_id
                     AND turn.session_id = session.id
                     AND turn.id = session.active_turn_id
                     AND turn.status = 'requires_action'
                 ) THEN 'decided_approval' END,
                 CASE WHEN NOT session.blocked AND EXISTS (
                   SELECT 1
                   FROM %1$I.session_goals goal
                   WHERE goal.workspace_id = session.workspace_id
                     AND goal.session_id = session.id
                     AND goal.status = 'active'
                 ) THEN 'active_goal' END,
                 CASE WHEN NOT session.blocked AND EXISTS (
                   SELECT 1
                   FROM %1$I.session_system_updates update_row
                   WHERE update_row.workspace_id = session.workspace_id
                     AND update_row.session_id = session.id
                     AND update_row.state = 'pending'
                 ) THEN 'pending_internal_updates' END,
                 CASE WHEN NOT session.blocked AND session.compact_requested
                   THEN 'compaction_requested' END
               ]::text[], NULL) AS reasons
        FROM control_state session
      )
      SELECT classified.account_id, classified.workspace_id, classified.session_id,
             classified.temporal_workflow_id, classified.reasons
      FROM classified
      WHERE cardinality(classified.reasons) > 0
      ORDER BY classified.workspace_id, classified.session_id
    $function$;
  $create$, target_schema);
END $continuability$;