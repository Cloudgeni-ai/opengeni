-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS "session_turns_unclaimed_prompt_trigger_idx"
  ON "session_turns" ("workspace_id", "session_id", "trigger_event_id")
  WHERE "started_at" IS NULL;
