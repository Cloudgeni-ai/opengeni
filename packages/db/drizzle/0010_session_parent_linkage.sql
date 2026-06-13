-- Parent linkage for spawned worker sessions. When a session is created via
-- the first-party MCP session_create tool and the caller's grant carries a
-- worker-signed sessionId claim (i.e. a manager session spawning a worker),
-- the new worker records that manager as its parent_session_id. Direct API
-- creates and scheduled-task runs carry no such claim and leave this NULL.
--
-- The column powers event-driven completion wakeups: when a session that has
-- a parent reaches a terminal-for-now state (goal completed, agent/system
-- paused goal, idle with no active goal after doing work, or failed), the
-- parent is woken with a system-authored message so the manager resumes and
-- reads the worker's output instead of busy-polling or stalling.
--
-- Self-referencing FK with ON DELETE SET NULL: deleting a manager session must
-- never cascade into its spawned workers; the link simply clears.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "parent_session_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'sessions_parent_session_id_fkey'
      AND table_name = 'sessions'
  ) THEN
    ALTER TABLE "sessions"
      ADD CONSTRAINT "sessions_parent_session_id_fkey"
      FOREIGN KEY ("parent_session_id") REFERENCES "sessions"("id") ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "sessions_parent_idx" ON "sessions" ("workspace_id", "parent_session_id");
