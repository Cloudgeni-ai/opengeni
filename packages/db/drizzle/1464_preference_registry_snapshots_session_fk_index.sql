-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS preference_registry_snapshots_session_fk_idx
ON preference_registry_snapshots (session_id);
