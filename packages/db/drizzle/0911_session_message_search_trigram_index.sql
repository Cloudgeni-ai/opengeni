-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
-- opengeni:pre-release
CREATE INDEX CONCURRENTLY IF NOT EXISTS "session_message_search_texts_trgm_idx"
  ON "session_message_search_texts" USING gin ("workspace_id", "text" gin_trgm_ops);
