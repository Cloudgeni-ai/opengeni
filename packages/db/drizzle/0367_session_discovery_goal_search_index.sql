-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_goals_discovery_active_text_fts_idx
  ON session_goals USING gin (to_tsvector('simple', text))
  WHERE status = 'active';
