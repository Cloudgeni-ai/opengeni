-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_system_update_outbox_child_terminal_source_idx
  ON session_system_update_outbox (workspace_id, source_session_id, target_session_id, created_at, id)
  WHERE kind = 'child_terminal_result';
