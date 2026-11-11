-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_system_updates_delivered_history_item_idx
  ON session_system_updates (delivered_history_item_id) WHERE delivered_history_item_id IS NOT NULL;
