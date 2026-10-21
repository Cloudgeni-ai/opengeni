-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_realtime_entries_history_item_idx
ON session_realtime_entries (history_item_id)
WHERE history_item_id IS NOT NULL;
