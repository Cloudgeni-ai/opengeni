-- deployment-mode: rolling
-- Turns parked waiting for subscription capacity, by provider, in the control
-- worker's existing turn hold summary.
--
-- A turn that hits a provider's usage limit (or finds no eligible account)
-- parks on its session's row in subscription_capacity_waiters: the turn and
-- the session become `waiting_capacity`, the attempt closes with outcome
-- `waiting_capacity`, and nothing runs until capacity returns. That parked
-- turn is the session's active turn, never a `queued` one, so
-- opengeni_turns_queued_by_hold{hold="waiting_capacity"} (0988) does not
-- count it: that class counts only further prompts queued behind it. A
-- deployment could have turns parked for hours with that gauge at 0.
--
-- opengeni_private.summarize_queued_turns_by_hold() keeps its signature, its
-- grant (1274) and its seven queued-turn classes, and gains one row per
-- waiter provider, `capacity_wait:claude`, `capacity_wait:codex` and
-- `capacity_wait:xai` (always all three, so an emptied provider reads 0):
-- the parked turns that will run as soon as capacity returns, with the age of
-- the oldest wait. A wait counts exactly when the capacity reconcile
-- (reconcileSubscriptionCoreCapacityWait) would resume it on capacity:
--   * its waiter still names the session's active turn, the session and that
--     turn are `waiting_capacity`, the turn has no live attempt and is at the
--     generation the waiter blocked, and the waiter's goal, if any, is still
--     active at the same version (otherwise the reconcile supersedes it);
--   * the session is not effectively paused: its own Pause or Stop, an
--     ancestor's not defeated by a newer subtree resume, or the workspace's
--     not defeated by any (the reconcile leaves a paused wait untouched; it
--     resumes only after Resume). This is the same pause algebra this
--     function already applies to queued turns, from session-control.ts.
-- A Stop's brief in-flight settlement is not modelled: it ends in the Pause
-- above. The age runs from the close of the attempt that parked the turn (a
-- resumption that lands straight back on missing capacity starts a new wait).
-- Counts and ages only, nothing that names a tenant.
--
-- Sessions, turns and attempts are row-secured even for their owner, so the
-- summary now reads inside the transaction's session inventory window (as
-- 1002 and 1474 do), and subscription_capacity_waiters and
-- workspace_inference_controls gain the read-only owner inventory policy
-- sessions and turns already have (as 0982 did for credit allocations).
-- Under an owner that does not bypass row security the queued classes now
-- read every queued turn, and every workspace Pause, instead of none.
--
-- Rolling: the previous release already has EXECUTE and reads only the seven
-- classes it knows, skipping the new rows. The policies admit only the owner
-- inside the window. The function's one write is the transaction's own
-- inventory capability row.
SET LOCAL lock_timeout = '5s';

DO $turn_hold_inventory$
DECLARE
  data_schema text := current_schema();
  table_name text;
  owner_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['subscription_capacity_waiters', 'workspace_inference_controls']
  LOOP
    SELECT pg_catalog.pg_get_userbyid(relowner) INTO STRICT owner_name FROM pg_catalog.pg_class
      WHERE oid = pg_catalog.format('%I.%I', data_schema, table_name)::regclass;
    EXECUTE pg_catalog.format(
      'CREATE POLICY session_tenancy_fence_inventory_read ON %1$I.%4$I '
      'FOR SELECT USING (%1$I.session_tenancy_fence_owner_policy_active('
      '(CURRENT_USER)::text, %2$L::text, %3$s::oid, workspace_id, true))',
      data_schema, owner_name, data_schema::regnamespace::oid, table_name);
  END LOOP;
END
$turn_hold_inventory$;

DO $turn_holds$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.summarize_queued_turns_by_hold()
    RETURNS TABLE (
      hold text,
      count bigint,
      oldest_age_seconds double precision
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    #variable_conflict use_column
    DECLARE inventory_id uuid;
    BEGIN
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(
        %1$I.session_tenancy_fence_target_schema());
      RETURN QUERY
      WITH RECURSIVE holds(hold) AS (
        VALUES
          ('ready'::text),
          ('behind_active_turn'::text),
          ('paused'::text),
          ('failed'::text),
          ('requires_action'::text),
          ('waiting_capacity'::text),
          ('cancelled'::text),
          ('capacity_wait:claude'::text),
          ('capacity_wait:codex'::text),
          ('capacity_wait:xai'::text)
      ), queued AS (
        SELECT turn.workspace_id, turn.session_id, turn.created_at
        FROM session_turns turn
        WHERE turn.status = 'queued'
      ), parked AS (
        -- The reconcile's own supersede checks, inverted.
        SELECT
          waiter.workspace_id,
          waiter.session_id,
          'capacity_wait:' || waiter.provider AS hold,
          COALESCE(
            (
              SELECT max(attempt.closed_at)
              FROM session_turn_attempts attempt
              WHERE attempt.workspace_id = waiter.workspace_id
                AND attempt.session_id = waiter.session_id
                AND attempt.turn_id = waiter.turn_id
                AND attempt.outcome = 'waiting_capacity'
            ),
            waiter.updated_at
          ) AS since
        FROM subscription_capacity_waiters waiter
        JOIN sessions chat
          ON chat.workspace_id = waiter.workspace_id
         AND chat.id = waiter.session_id
         AND chat.active_turn_id = waiter.turn_id
         AND chat.status = 'waiting_capacity'
        JOIN session_turns turn
          ON turn.workspace_id = waiter.workspace_id
         AND turn.id = waiter.turn_id
         AND turn.status = 'waiting_capacity'
         AND turn.active_attempt_id IS NULL
         AND turn.execution_generation = waiter.blocked_turn_generation
        WHERE waiter.goal_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM session_goals goal
            WHERE goal.workspace_id = waiter.workspace_id
              AND goal.id = waiter.goal_id
              AND goal.session_id = waiter.session_id
              AND goal.status = 'active'
              AND goal.version = waiter.goal_version
          )
      ), candidate_sessions AS (
        SELECT DISTINCT
          session.workspace_id,
          session.id AS session_id,
          session.status,
          session.active_turn_id
        FROM (
          SELECT queued.workspace_id, queued.session_id FROM queued
          UNION
          SELECT parked.workspace_id, parked.session_id FROM parked
        ) wanted
        JOIN sessions session
          ON session.workspace_id = wanted.workspace_id
         AND session.id = wanted.session_id
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
          queued.created_at AS since
        FROM queued
        JOIN candidate_sessions candidate
          ON candidate.workspace_id = queued.workspace_id
         AND candidate.session_id = queued.session_id
        LEFT JOIN effectively_paused paused
          ON paused.session_id = candidate.session_id
        UNION ALL
        SELECT parked.hold, parked.since
        FROM parked
        WHERE NOT EXISTS (
          SELECT 1 FROM effectively_paused paused WHERE paused.session_id = parked.session_id
        )
      )
      SELECT
        holds.hold,
        count(classified.hold)::bigint,
        COALESCE(
          GREATEST(0, EXTRACT(EPOCH FROM (now() - min(classified.since)))),
          0
        )::double precision
      FROM holds
      LEFT JOIN classified ON classified.hold = holds.hold
      GROUP BY holds.hold
      ORDER BY holds.hold;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END
    $body$
  $definition$, data_schema);
END
$turn_holds$;

REVOKE ALL ON FUNCTION opengeni_private.summarize_queued_turns_by_hold() FROM PUBLIC;
