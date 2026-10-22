-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_events_workspace_attempt_idx
ON session_events (workspace_id, turn_attempt_id)
WHERE turn_attempt_id IS NOT NULL;
