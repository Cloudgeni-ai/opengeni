-- deployment-mode: maintenance
-- A cancelled attempt records the exact boundary after which it has no
-- inference, user-visible output, or workspace-persistence authority.
-- Fenced/idempotent cleanup and telemetry may still finish. Temporal
-- independently waits for the activity to terminate; this receipt lets queue
-- admission and UI state use durable truth.

SET lock_timeout = '5s';
SET statement_timeout = '5min';

ALTER TABLE "session_turn_attempts"
  ADD COLUMN "quiesced_at" timestamptz;

-- Maintenance mode drains the pre-cutover workers before this backfill, so an
-- interrupted attempt that is already closed has also left its physical
-- activity. Seed only that historical population; new activity/workflow code
-- owns all later receipts.
UPDATE "session_turn_attempts" AS attempt
SET "quiesced_at" = COALESCE(attempt."closed_at", attempt."updated_at", now())
WHERE attempt."state" = 'closed'
  AND EXISTS (
    SELECT 1
    FROM "session_attempt_interruptions" AS interruption
    WHERE interruption."workspace_id" = attempt."workspace_id"
      AND interruption."attempt_id" = attempt."id"
  );
