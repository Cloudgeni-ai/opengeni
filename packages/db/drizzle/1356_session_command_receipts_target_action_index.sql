-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_command_receipts_target_action_idx
  ON session_command_receipts (workspace_id, target_session_id, action);
