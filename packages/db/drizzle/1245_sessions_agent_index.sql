-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_agent_idx
ON sessions (workspace_id, agent_id, created_at DESC)
WHERE agent_id IS NOT NULL;
