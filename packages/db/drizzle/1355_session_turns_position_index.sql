-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_turns_session_position_idx
  ON session_turns (workspace_id, session_id, position);
