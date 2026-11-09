-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_realtime_entries_source_update_idx
  ON session_realtime_entries (source_update_id) WHERE source_update_id IS NOT NULL;
