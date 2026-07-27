-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS "session_events_duplicate_of_event_idx"
  ON "session_events" ("duplicate_of_event_id");
