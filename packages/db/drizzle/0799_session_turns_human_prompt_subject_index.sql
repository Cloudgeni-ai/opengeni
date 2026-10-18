-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_turns_human_prompt_subject_idx
  ON session_turns (workspace_id, initiator_subject_id, session_id)
  WHERE initiator_kind = 'subject' AND source IN ('user', 'api') AND surface IS DISTINCT FROM 'agent';
