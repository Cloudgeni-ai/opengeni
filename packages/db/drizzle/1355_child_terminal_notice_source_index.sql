-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_system_updates_child_terminal_source_idx
  ON session_system_updates (workspace_id, session_id, source_id, created_at, id)
  WHERE kind = 'child_terminal_result';
