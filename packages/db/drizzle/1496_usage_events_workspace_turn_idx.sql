-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
-- opengeni:pre-release
CREATE INDEX CONCURRENTLY IF NOT EXISTS usage_events_workspace_turn_idx
ON usage_events (workspace_id, turn_id)
WHERE turn_id IS NOT NULL;
