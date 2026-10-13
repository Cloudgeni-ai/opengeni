-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_turns_setup_outcome_unknown_idx
  ON session_turns (workspace_id, session_id)
  WHERE status = 'recovering' AND metadata ? 'sandboxSetupOutcomeUnknown';
