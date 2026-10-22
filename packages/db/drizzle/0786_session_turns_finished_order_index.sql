-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_turns_finished_order_idx
ON session_turns (workspace_id, session_id, finished_at DESC, "position" DESC, created_at DESC)
WHERE finished_at IS NOT NULL;
