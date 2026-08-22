-- deployment-mode: rolling
SET lock_timeout = '5s';
SET statement_timeout = '10min';

-- Agent-declared goal continuation hold.
--
-- An orchestrator whose active goal depends on child sessions or an external
-- event can call the first-party `goal_wait` tool instead of busy-polling. The
-- hold is additive state on the goal row: the exact turn that declared it, the
-- mandatory deadline, a bounded reason, and when it was recorded. The
-- continuation materializer honors the hold only while the declaring turn is
-- still the latest finished turn and the deadline has not passed; it never
-- consumes the wake/observed revision ledger, so a crash cannot lose the
-- obligation. Any newer finished turn, a passed deadline, or a human/API/agent
-- goal mutation clears all four columns together.
--
-- An old worker that ignores these columns keeps the prior behaviour
-- (immediate continuation), so this is a rolling, additive change with no
-- backfill.

ALTER TABLE "session_goals"
  ADD COLUMN IF NOT EXISTS "continuation_hold_turn_id" uuid,
  ADD COLUMN IF NOT EXISTS "continuation_hold_until" timestamptz,
  ADD COLUMN IF NOT EXISTS "continuation_hold_reason" text,
  ADD COLUMN IF NOT EXISTS "continuation_hold_set_at" timestamptz;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_goals_continuation_hold_check'
      AND conrelid = 'session_goals'::regclass
  ) THEN
    ALTER TABLE "session_goals"
      ADD CONSTRAINT "session_goals_continuation_hold_check"
      CHECK (
        (
          "continuation_hold_turn_id" IS NULL
          AND "continuation_hold_until" IS NULL
          AND "continuation_hold_reason" IS NULL
          AND "continuation_hold_set_at" IS NULL
        )
        OR (
          "continuation_hold_turn_id" IS NOT NULL
          AND "continuation_hold_until" IS NOT NULL
          AND "continuation_hold_set_at" IS NOT NULL
          AND (
            "continuation_hold_reason" IS NULL
            OR octet_length("continuation_hold_reason") <= 2048
          )
        )
      );
  END IF;
END
$constraints$;

COMMENT ON COLUMN "session_goals"."continuation_hold_turn_id" IS
  'Exact turn that declared the goal_wait hold; the hold applies only while this is the latest finished turn.';
COMMENT ON COLUMN "session_goals"."continuation_hold_until" IS
  'Mandatory hold deadline; the materializer re-arms a delayed workflow wake at this time and clears the hold once it passes.';
COMMENT ON COLUMN "session_goals"."continuation_hold_reason" IS
  'Bounded (2 KiB) agent-declared reason for the hold.';
COMMENT ON COLUMN "session_goals"."continuation_hold_set_at" IS
  'When the hold was recorded.';
