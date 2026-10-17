-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_events_usage_source_key_idx
ON session_events (workspace_id, turn_id, usage_source_key)
WHERE usage_source_key IS NOT NULL;
