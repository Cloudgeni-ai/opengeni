-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_system_updates_delivered_turn_idx
ON session_system_updates (workspace_id, delivered_turn_id)
WHERE delivered_turn_id IS NOT NULL;
