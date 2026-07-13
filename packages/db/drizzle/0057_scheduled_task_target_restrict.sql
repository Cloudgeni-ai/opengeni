-- A targeted scheduled task must never turn a deleted thread into the
-- task-owned reusable-session fallback. Upgrade installations that applied
-- 0056 before this lifecycle fence.
ALTER TABLE "scheduled_tasks"
  DROP CONSTRAINT IF EXISTS "scheduled_tasks_target_session_id_fk";

ALTER TABLE "scheduled_tasks"
  ADD CONSTRAINT "scheduled_tasks_target_session_id_fk"
  FOREIGN KEY ("target_session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT;

-- 0056 may already have accepted a target before the rolling-worker mirror and
-- route stamp existed. The target session owns this immutable route; align the
-- legacy worker configuration unconditionally rather than preserving a stale
-- or null deployment route.
UPDATE "scheduled_tasks" AS task
SET "reusable_session_id" = task."target_session_id",
    "agent_config" = jsonb_set(
      task."agent_config",
      '{sandboxBackend}',
      to_jsonb(session."sandbox_backend"),
      true
    )
FROM "sessions" AS session
WHERE task."target_session_id" = session."id"
  AND task."target_session_id" IS NOT NULL;

-- The legacy worker only understands reusable_session_id. Keep the rolling
-- deployment mirror enforceable at the database boundary, not just in the new
-- API/worker code, so a target can never silently fall back on an old worker.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'scheduled_tasks_target_legacy_route_ck'
       AND conrelid = 'scheduled_tasks'::regclass
  ) THEN
    ALTER TABLE "scheduled_tasks"
      ADD CONSTRAINT "scheduled_tasks_target_legacy_route_ck"
      CHECK ("target_session_id" IS NULL OR "reusable_session_id" = "target_session_id");
  END IF;
END $$;