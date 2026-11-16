-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_execution_context_turn_fk_idx
ON sessions (execution_context_turn_id)
WHERE execution_context_turn_id IS NOT NULL;
