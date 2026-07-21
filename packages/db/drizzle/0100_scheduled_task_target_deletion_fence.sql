-- Repair the target-session foreign key for installations that already
-- recorded 0096/0097.  A same-named constraint in another schema must never
-- make a dedicated-schema migration skip this table's deletion fence.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'scheduled_tasks'::regclass
       AND constraint_row.conname = 'scheduled_tasks_target_session_id_fk'
       AND constraint_row.confrelid = 'sessions'::regclass
       AND constraint_row.confdeltype = 'r'
  ) THEN
    ALTER TABLE "scheduled_tasks"
      DROP CONSTRAINT IF EXISTS "scheduled_tasks_target_session_id_fk";
    ALTER TABLE "scheduled_tasks"
      ADD CONSTRAINT "scheduled_tasks_target_session_id_fk"
      FOREIGN KEY ("target_session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT;
  END IF;
END $$;
