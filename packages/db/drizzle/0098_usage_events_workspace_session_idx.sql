-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS "usage_events_workspace_session_idx"
  ON "usage_events" ("workspace_id", "session_id", "occurred_at");
