-- deployment-mode: rolling
-- Durable, per-subject follow-up state for the session rail. This extends the
-- existing FORCE-RLS personal session relation so read/active-work state shares
-- the same workspace, subject, membership-removal, and visibility fences as
-- personal pins. Opening a session never writes this state.

ALTER TABLE "session_pins"
  ADD COLUMN IF NOT EXISTS "acknowledged_sequence" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "actively_working" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "attention_version" integer NOT NULL DEFAULT 1;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_pins_acknowledged_sequence_floor'
      AND conrelid = 'session_pins'::regclass
  ) THEN
    ALTER TABLE "session_pins"
      ADD CONSTRAINT "session_pins_acknowledged_sequence_floor"
      CHECK ("acknowledged_sequence" >= -1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_pins_attention_version_positive'
      AND conrelid = 'session_pins'::regclass
  ) THEN
    ALTER TABLE "session_pins"
      ADD CONSTRAINT "session_pins_attention_version_positive"
      CHECK ("attention_version" >= 1);
  END IF;
END
$constraints$;

COMMENT ON COLUMN "session_pins"."acknowledged_sequence" IS
  'Highest durable session event sequence this subject explicitly acknowledged; -1 is an explicit unread sentinel for a zero-sequence session, and route views never advance it.';
COMMENT ON COLUMN "session_pins"."actively_working" IS
  'Personal durable label indicating that this subject intends to continue work on the session.';
COMMENT ON COLUMN "session_pins"."attention_version" IS
  'Independent optimistic revision for acknowledged_sequence and actively_working.';
