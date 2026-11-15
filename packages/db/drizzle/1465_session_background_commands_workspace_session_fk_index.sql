-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_background_commands_workspace_session_fk_idx
ON session_background_commands (workspace_id, session_id);
