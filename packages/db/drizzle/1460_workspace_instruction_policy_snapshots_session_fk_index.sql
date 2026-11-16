-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS workspace_instruction_policy_snapshots_session_fk_idx
ON workspace_instruction_policy_snapshots (session_id);
