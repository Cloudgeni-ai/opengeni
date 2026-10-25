-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_history_items_scope_turn_position_idx
ON session_history_items (workspace_id, session_id, turn_id, position)
WHERE turn_id IS NOT NULL;
