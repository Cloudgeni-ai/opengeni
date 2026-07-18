-- deployment-mode: maintenance
-- OPE-21 intentionally changes the waiter/worker contract in one no-overlap
-- cutover: old workers terminally settled capacity waits, while new workers
-- preserve the same logical turn. Do not run old and new workers concurrently.

ALTER TABLE "session_turn_attempts"
  DROP CONSTRAINT "session_turn_attempts_outcome_check";
ALTER TABLE "session_turn_attempts"
  ADD CONSTRAINT "session_turn_attempts_outcome_check"
  CHECK (
    "outcome" IS NULL OR "outcome" IN (
      'completed', 'failed', 'cancelled', 'superseded', 'requires_action',
      'waiting_capacity', 'interrupted_recoverable',
      'lease_lost_recoverable', 'pre_cutover_closed'
    )
  );

-- A waiter is turn-owned. Goal identity is only an optional generation fence,
-- so goal-less prompts can wait and goal deletion cannot cascade away the
-- durable ledger before reconciliation supersedes the blocked turn.
ALTER TABLE "codex_capacity_waiters"
  DROP CONSTRAINT "codex_capacity_waiters_workspace_goal_fk";
ALTER TABLE "codex_capacity_waiters"
  ALTER COLUMN "goal_id" DROP NOT NULL,
  ALTER COLUMN "goal_version" DROP NOT NULL,
  ADD COLUMN "blocked_turn_generation" integer;

UPDATE "codex_capacity_waiters" waiter
SET "blocked_turn_generation" = turn."execution_generation"
FROM "session_turns" turn
WHERE turn."workspace_id" = waiter."workspace_id"
  AND turn."id" = waiter."blocked_turn_id";

DO $audit$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "codex_capacity_waiters"
    WHERE "blocked_turn_generation" IS NULL
       OR "blocked_turn_generation" < 1
       OR (("goal_id" IS NULL) <> ("goal_version" IS NULL))
       OR ("goal_version" IS NOT NULL AND "goal_version" < 1)
  ) THEN
    RAISE EXCEPTION 'codex capacity same-turn backfill found an invalid waiter';
  END IF;
END $audit$;

ALTER TABLE "codex_capacity_waiters"
  ALTER COLUMN "blocked_turn_generation" SET NOT NULL,
  DROP CONSTRAINT IF EXISTS "codex_capacity_waiters_generation_check",
  ADD CONSTRAINT "codex_capacity_waiters_generation_check"
  CHECK (
    "generation" > 0
    AND "blocked_turn_generation" > 0
    AND (
      ("goal_id" IS NULL AND "goal_version" IS NULL)
      OR ("goal_id" IS NOT NULL AND "goal_version" > 0)
    )
  );