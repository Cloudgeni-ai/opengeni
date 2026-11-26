-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_goals_active_session_idx
ON session_goals (session_id)
WHERE status = 'active';
