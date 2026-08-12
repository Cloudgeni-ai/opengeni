-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_workspace_channel_idx"
  ON "sessions" ("workspace_id", "channel_id")
  WHERE "channel_id" IS NOT NULL;
