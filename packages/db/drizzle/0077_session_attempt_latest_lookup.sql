-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS "session_turn_attempts_latest_session_idx"
  ON "session_turn_attempts" ("workspace_id", "session_id", "started_at" DESC, "id" DESC);
