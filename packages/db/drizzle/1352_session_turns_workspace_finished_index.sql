-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_turns_workspace_finished_idx
  ON session_turns (workspace_id, finished_at) WHERE finished_at IS NOT NULL;
