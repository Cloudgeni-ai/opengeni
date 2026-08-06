-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS "session_events_workspace_turn_type_idx"
  ON "session_events" ("workspace_id", "turn_id", "type")
  WHERE "turn_id" IS NOT NULL;
