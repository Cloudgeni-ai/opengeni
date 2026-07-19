-- deployment-mode: rolling
-- OPE-59: a goal-owned, monotonic continuation obligation. PostgreSQL is the
-- authority; Temporal receives only repairable workflow nudges.
ALTER TABLE "session_goals"
  ADD COLUMN IF NOT EXISTS "continuation_wake_revision" bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "continuation_observed_revision" bigint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'session_goals_continuation_revision_check'
      AND conrelid = 'session_goals'::regclass
  ) THEN
    ALTER TABLE "session_goals"
      ADD CONSTRAINT "session_goals_continuation_revision_check"
      CHECK (
        "continuation_wake_revision" >= 0
        AND "continuation_observed_revision" >= 0
        AND "continuation_observed_revision" <= "continuation_wake_revision"
        AND "continuation_wake_revision" <= 9007199254740991
        AND "continuation_observed_revision" <= 9007199254740991
      );
  END IF;
END $$;

-- Drizzle and every public workflow/client contract represent revisions as
-- JavaScript numbers. Reject manual corruption or impossible exhaustion in
-- PostgreSQL before a bigint can be rounded into another producer's revision.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'session_workflow_wake_outbox_revision_safe_check'
      AND conrelid = 'session_workflow_wake_outbox'::regclass
  ) THEN
    ALTER TABLE "session_workflow_wake_outbox"
      ADD CONSTRAINT "session_workflow_wake_outbox_revision_safe_check"
      CHECK (
        "wake_revision" <= 9007199254740991
        AND "delivered_revision" <= 9007199254740991
      );
  END IF;
END $$;

-- Legacy evaluation and update insertion were separate commits. A lost
-- response could therefore leave more than one current-version continuation,
-- and old generic failure handling could leave the only one deferred (which
-- is intentionally not independently runnable). Preserve the earliest
-- admitted update, normalize it to pending, and cancel later duplicates before
-- assigning the baseline obligation.
WITH ranked AS (
  SELECT update.id,
         row_number() OVER (
           PARTITION BY update.workspace_id, update.session_id
           ORDER BY update.created_at, update.id
         ) AS ordinal
  FROM "session_system_updates" AS update
  JOIN "session_goals" AS goal
    ON goal.workspace_id = update.workspace_id
   AND goal.session_id = update.session_id
   AND update.payload ->> 'goalId' = goal.id::text
   AND update.payload ->> 'goalVersion' = goal.version::text
  WHERE goal.status = 'active'
    AND update.kind = 'goal_continuation'
    AND update.state IN ('pending', 'deferred')
)
UPDATE "session_system_updates" AS update
SET state = CASE WHEN ranked.ordinal = 1 THEN 'pending' ELSE 'cancelled' END,
    delivered_turn_id = NULL,
    delivered_at = NULL
FROM ranked
WHERE update.id = ranked.id;

-- A surviving current-version pending continuation is already-materialized
-- work. Mark one synthetic baseline revision observed so deployment cannot
-- manufacture another continuation beside it. This baseline is valid even
-- while admission is paused: Resume will rediscover the pending update and
-- register its own authoritative wake. Only effectively-active targets receive
-- a rollout wake here. The fresh wake is required even when an older signal
-- revision was acknowledged: its workflow may have died after signal delivery
-- but before claiming the update. A delivered update is not itself
-- outstanding: its owning nonterminal turn is protected by the repair query
-- below, while an idle goal whose delivered turn already settled still needs a
-- new obligation. Likewise, a stale-version update cannot satisfy the current
-- goal.
--
-- Keep this admission projection identical to projectEffectiveControl:
-- descendant overrides defeat only more-distant session pauses, any ancestry
-- override may defeat a workspace pause, and incomplete/cyclic/over-limit
-- ancestry fails closed. The recursive term admits a root at depth 10,000 but
-- stops before traversing past it, matching SESSION_ANCESTRY_LIMIT.
WITH RECURSIVE materialized AS (
  SELECT goal.id, goal.account_id, goal.workspace_id, goal.session_id,
         COALESCE(session.temporal_workflow_id, 'session-' || session.id::text) AS workflow_id
  FROM "session_goals" AS goal
  JOIN "sessions" AS session
    ON session.workspace_id = goal.workspace_id AND session.id = goal.session_id
  WHERE goal.status = 'active'
    AND goal.continuation_wake_revision = 0
    AND goal.continuation_observed_revision = 0
    AND EXISTS (
      SELECT 1
      FROM "session_system_updates" AS update
      WHERE update.workspace_id = goal.workspace_id
        AND update.session_id = goal.session_id
        AND update.kind = 'goal_continuation'
        AND update.state = 'pending'
        AND update.payload ->> 'goalId' = goal.id::text
        AND update.payload ->> 'goalVersion' = goal.version::text
    )
), ancestry AS (
  SELECT materialized.id AS goal_id, session.workspace_id,
         session.id AS session_id, session.parent_session_id,
         session.direct_control_state, session.direct_pause_revision,
         session.subtree_run_override_revision,
         0::integer AS depth, ARRAY[session.id]::uuid[] AS path, false AS cycle
  FROM materialized
  JOIN "sessions" AS session
    ON session.workspace_id = materialized.workspace_id
   AND session.id = materialized.session_id
  UNION ALL
  SELECT child.goal_id, parent.workspace_id,
         parent.id, parent.parent_session_id,
         parent.direct_control_state, parent.direct_pause_revision,
         parent.subtree_run_override_revision,
         child.depth + 1, child.path || parent.id,
         parent.id = ANY(child.path)
  FROM ancestry AS child
  JOIN "sessions" AS parent
    ON parent.workspace_id = child.workspace_id
   AND parent.id = child.parent_session_id
  WHERE child.parent_session_id IS NOT NULL
    AND NOT child.cycle
    AND child.depth < 10000
), admitted AS (
  SELECT materialized.id
  FROM materialized
  JOIN "workspace_inference_controls" AS control
    ON control.workspace_id = materialized.workspace_id
  WHERE EXISTS (
      SELECT 1
      FROM ancestry AS root
      WHERE root.goal_id = materialized.id
        AND root.parent_session_id IS NULL
        AND NOT root.cycle
    )
    AND NOT EXISTS (
      SELECT 1
      FROM ancestry AS invalid
      WHERE invalid.goal_id = materialized.id AND invalid.cycle
    )
    AND NOT EXISTS (
      SELECT 1
      FROM ancestry AS pause
      WHERE pause.goal_id = materialized.id
        AND pause.direct_control_state = 'paused'
        AND NOT EXISTS (
          SELECT 1
          FROM ancestry AS override
          WHERE override.goal_id = materialized.id
            AND override.depth < pause.depth
            AND override.subtree_run_override_revision > pause.direct_pause_revision
        )
    )
    AND (
      control.workspace_state = 'active'
      OR (
        control.workspace_state = 'paused'
        AND EXISTS (
          SELECT 1
          FROM ancestry AS override
          WHERE override.goal_id = materialized.id
            AND override.subtree_run_override_revision > control.workspace_pause_revision
        )
      )
    )
), baselined AS (
  UPDATE "session_goals" AS goal
  SET "continuation_wake_revision" = 1,
      "continuation_observed_revision" = 1,
      "updated_at" = now()
  FROM materialized
  WHERE goal.id = materialized.id
  RETURNING materialized.account_id, materialized.workspace_id,
            materialized.session_id, materialized.workflow_id,
            EXISTS (SELECT 1 FROM admitted WHERE admitted.id = materialized.id) AS admitted
)
INSERT INTO "session_workflow_wake_outbox" (
  "session_id", "account_id", "workspace_id", "temporal_workflow_id",
  "wake_revision", "delivered_revision", "reason", "attempts",
  "next_attempt_at", "created_at", "updated_at"
)
SELECT session_id, account_id, workspace_id, workflow_id,
       1, 0, 'goal_materialized_backfill', 0, now(), now(), now()
FROM baselined
WHERE admitted
ON CONFLICT ("session_id") DO UPDATE SET
  "temporal_workflow_id" = EXCLUDED."temporal_workflow_id",
  "wake_revision" = "session_workflow_wake_outbox"."wake_revision" + 1,
  "reason" = EXCLUDED."reason",
  "attempts" = 0,
  "next_attempt_at" = LEAST("session_workflow_wake_outbox"."next_attempt_at", EXCLUDED."next_attempt_at"),
  "last_error" = NULL,
  "updated_at" = now();

-- An active, admitted-idle goal with neither work nor a capacity waiter is the
-- legacy catch-and-idle hole. Arm exactly one revision. Human/API queue rows,
-- live/approval turns, capacity waiters, and paused or malformed ancestry
-- remain authoritative and will arm or resume through their own boundary.
WITH RECURSIVE candidates AS (
  SELECT goal.id, goal.account_id, goal.workspace_id, goal.session_id,
         COALESCE(session.temporal_workflow_id, 'session-' || session.id::text) AS workflow_id
  FROM "session_goals" AS goal
  JOIN "sessions" AS session
    ON session.workspace_id = goal.workspace_id AND session.id = goal.session_id
  WHERE goal.status = 'active'
    -- Only untouched legacy rows are deployment repair candidates. The
    -- baseline update above deliberately changes already-materialized goals to
    -- 1/1; accepting arbitrary equal revisions here would immediately re-arm
    -- those same goals and manufacture a duplicate continuation.
    AND goal.continuation_wake_revision = 0
    AND goal.continuation_observed_revision = 0
    AND session.status <> 'cancelled'
    AND session.active_turn_id IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "session_turns" AS turn
      WHERE turn.workspace_id = goal.workspace_id
        AND turn.session_id = goal.session_id
        AND turn.status IN ('queued', 'running', 'requires_action', 'recovering', 'waiting_capacity')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "codex_capacity_waiters" AS waiter
      WHERE waiter.workspace_id = goal.workspace_id
        AND waiter.session_id = goal.session_id
        AND waiter.status = 'waiting'
    )
), ancestry AS (
  SELECT candidate.id AS goal_id, session.workspace_id,
         session.id AS session_id, session.parent_session_id,
         session.direct_control_state, session.direct_pause_revision,
         session.subtree_run_override_revision,
         0::integer AS depth, ARRAY[session.id]::uuid[] AS path, false AS cycle
  FROM candidates AS candidate
  JOIN "sessions" AS session
    ON session.workspace_id = candidate.workspace_id
   AND session.id = candidate.session_id
  UNION ALL
  SELECT child.goal_id, parent.workspace_id,
         parent.id, parent.parent_session_id,
         parent.direct_control_state, parent.direct_pause_revision,
         parent.subtree_run_override_revision,
         child.depth + 1, child.path || parent.id,
         parent.id = ANY(child.path)
  FROM ancestry AS child
  JOIN "sessions" AS parent
    ON parent.workspace_id = child.workspace_id
   AND parent.id = child.parent_session_id
  WHERE child.parent_session_id IS NOT NULL
    AND NOT child.cycle
    AND child.depth < 10000
), repairable AS (
  SELECT candidate.*
  FROM candidates AS candidate
  JOIN "workspace_inference_controls" AS control
    ON control.workspace_id = candidate.workspace_id
  WHERE EXISTS (
      SELECT 1
      FROM ancestry AS root
      WHERE root.goal_id = candidate.id
        AND root.parent_session_id IS NULL
        AND NOT root.cycle
    )
    AND NOT EXISTS (
      SELECT 1
      FROM ancestry AS invalid
      WHERE invalid.goal_id = candidate.id AND invalid.cycle
    )
    AND NOT EXISTS (
      SELECT 1
      FROM ancestry AS pause
      WHERE pause.goal_id = candidate.id
        AND pause.direct_control_state = 'paused'
        AND NOT EXISTS (
          SELECT 1
          FROM ancestry AS override
          WHERE override.goal_id = candidate.id
            AND override.depth < pause.depth
            AND override.subtree_run_override_revision > pause.direct_pause_revision
        )
    )
    AND (
      control.workspace_state = 'active'
      OR (
        control.workspace_state = 'paused'
        AND EXISTS (
          SELECT 1
          FROM ancestry AS override
          WHERE override.goal_id = candidate.id
            AND override.subtree_run_override_revision > control.workspace_pause_revision
        )
      )
    )
), armed AS (
  UPDATE "session_goals" AS goal
  SET "continuation_wake_revision" = goal.continuation_wake_revision + 1,
      "updated_at" = now()
  FROM repairable
  WHERE goal.id = repairable.id
  RETURNING repairable.account_id, repairable.workspace_id,
            repairable.session_id, repairable.workflow_id
)
INSERT INTO "session_workflow_wake_outbox" (
  "session_id", "account_id", "workspace_id", "temporal_workflow_id",
  "wake_revision", "delivered_revision", "reason", "attempts",
  "next_attempt_at", "created_at", "updated_at"
)
SELECT session_id, account_id, workspace_id, workflow_id,
       1, 0, 'goal_obligation_backfill', 0, now(), now(), now()
FROM armed
ON CONFLICT ("session_id") DO UPDATE SET
  "temporal_workflow_id" = EXCLUDED."temporal_workflow_id",
  "wake_revision" = "session_workflow_wake_outbox"."wake_revision" + 1,
  "reason" = EXCLUDED."reason",
  "attempts" = 0,
  "next_attempt_at" = LEAST("session_workflow_wake_outbox"."next_attempt_at", EXCLUDED."next_attempt_at"),
  "last_error" = NULL,
  "updated_at" = now();