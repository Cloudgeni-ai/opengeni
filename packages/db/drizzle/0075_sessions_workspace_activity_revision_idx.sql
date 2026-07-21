-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY "sessions_workspace_activity_revision_idx"
  ON "sessions" ("workspace_id", "activity_revision" DESC, "updated_at" DESC, "id" DESC);