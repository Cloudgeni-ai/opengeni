-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_turns_execution_context_turn_fk_idx
ON session_turns (execution_context_turn_id)
WHERE execution_context_turn_id IS NOT NULL;
