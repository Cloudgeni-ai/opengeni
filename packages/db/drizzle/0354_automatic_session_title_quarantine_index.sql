-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_automatic_title_quarantine_v1_idx
ON sessions (id)
WHERE title_source IS DISTINCT FROM 'user'
  AND (
    title IS DISTINCT FROM 'New conversation'
    OR title_source IS DISTINCT FROM 'agent'
  );