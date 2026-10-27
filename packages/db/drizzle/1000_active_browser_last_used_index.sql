-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS browser_sessions_active_last_used_idx
ON browser_sessions (last_used_at, id)
WHERE lifecycle = 'active' AND controller_generation IS NOT NULL;
