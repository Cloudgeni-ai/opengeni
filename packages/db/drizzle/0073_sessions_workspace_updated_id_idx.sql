-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_workspace_updated_id_idx"
  ON "sessions" ("workspace_id", "updated_at" DESC, "id" DESC);
