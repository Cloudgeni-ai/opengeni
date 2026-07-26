-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY "sessions_workspace_created_id_idx"
  ON "sessions" ("workspace_id", "created_at" DESC, "id" DESC);
