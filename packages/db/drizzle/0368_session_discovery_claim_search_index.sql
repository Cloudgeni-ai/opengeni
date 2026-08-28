-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_work_claims_discovery_text_fts_idx
  ON session_work_claims USING gin (
    to_tsvector('simple', canonical_key || ' ' || coalesce(display_label, ''))
  );
