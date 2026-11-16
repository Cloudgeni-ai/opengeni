-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_learning_snapshots_workspace_turn_fk_idx
ON agent_learning_snapshots (workspace_id, turn_id);
