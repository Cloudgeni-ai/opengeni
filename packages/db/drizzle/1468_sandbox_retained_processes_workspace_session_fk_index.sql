-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS sandbox_retained_processes_workspace_session_fk_idx
ON sandbox_retained_processes (workspace_id, session_id);
