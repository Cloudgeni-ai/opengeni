-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_discovery_title_fts_idx
  ON sessions USING gin (to_tsvector('simple', title))
  WHERE title IS NOT NULL;
