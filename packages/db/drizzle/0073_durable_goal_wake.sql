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
-- manufacture another continuation beside it, then commit a fresh workflow
-- wake. The fresh wake is required even when an older signal revision was
-- acknowledged: its workflow may have died after signal delivery but before
-- claiming the update. A delivered update is not itself outstanding: its
-- owning nonterminal turn is protected by the repair query below, while an
-- idle goal whose delivered turn already settled still needs a new obligation.
-- Likewise, a stale-version update cannot satisfy the current goal.
WITH materialized AS (
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
), baselined AS (
  UPDATE "session_goals" AS goal
  SET "continuation_wake_revision" = 1,
      "continuation_observed_revision" = 1,
      "updated_at" = now()
  FROM materialized
  WHERE goal.id = materialized.id
  RETURNING materialized.account_id, materialized.workspace_id,
            materialized.session_id, materialized.workflow_id
)
INSERT INTO "session_workflow_wake_outbox" (
  "session_id", "account_id", "workspace_id", "temporal_workflow_id",
  "wake_revision", "delivered_revision", "reason", "attempts",
  "next_attempt_at", "created_at", "updated_at"
)
SELECT session_id, account_id, workspace_id, workflow_id,
       1, 0, 'goal_materialized_backfill', 0, now(), now(), now()
FROM baselined
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
-- live/approval turns, and capacity waiters remain authoritative and will arm
-- or resume through their own settlement boundary.
WITH repairable AS (
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