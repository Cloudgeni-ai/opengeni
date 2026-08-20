-- deployment-mode: rolling
-- Personal chat archiving shares the existing FORCE-RLS session organization
-- relation. Archiving one root hides its entire chat tree only for that subject.

ALTER TABLE "session_pins"
  ADD COLUMN IF NOT EXISTS "archived" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "archived_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "archive_version" integer NOT NULL DEFAULT 1;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_pins_archive_version_positive' AND conrelid = 'session_pins'::regclass) THEN
    ALTER TABLE "session_pins" ADD CONSTRAINT "session_pins_archive_version_positive" CHECK ("archive_version" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_pins_archive_state_consistent' AND conrelid = 'session_pins'::regclass) THEN
    ALTER TABLE "session_pins" ADD CONSTRAINT "session_pins_archive_state_consistent"
      CHECK (("archived" AND "archived_at" IS NOT NULL) OR (NOT "archived" AND "archived_at" IS NULL));
  END IF;
END
$constraints$;

CREATE INDEX IF NOT EXISTS "session_pins_workspace_subject_archived_idx"
  ON "session_pins" ("workspace_id", "subject_id", "archived", "archived_at" DESC, "session_id" DESC);

ALTER TABLE "session_list_snapshots"
  ADD COLUMN IF NOT EXISTS "archive_mode" text NOT NULL DEFAULT 'active';

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_list_snapshots_archive_mode_valid' AND conrelid = 'session_list_snapshots'::regclass) THEN
    ALTER TABLE "session_list_snapshots" ADD CONSTRAINT "session_list_snapshots_archive_mode_valid"
      CHECK ("archive_mode" IN ('active', 'archived'));
  END IF;
END
$constraints$;
