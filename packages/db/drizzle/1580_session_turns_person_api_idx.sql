-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_turns_session_person_api_idx
ON session_turns (workspace_id, session_id)
WHERE source IN ('user', 'api');
