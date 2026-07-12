ALTER TABLE "scheduled_tasks"
  ADD COLUMN IF NOT EXISTS "target_session_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_tasks_target_session_id_fk'
  ) THEN
    ALTER TABLE "scheduled_tasks"
      ADD CONSTRAINT "scheduled_tasks_target_session_id_fk"
      FOREIGN KEY ("target_session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "scheduled_tasks_target_session_idx"
  ON "scheduled_tasks" ("workspace_id", "target_session_id");
