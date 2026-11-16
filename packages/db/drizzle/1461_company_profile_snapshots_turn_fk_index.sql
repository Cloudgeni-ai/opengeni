-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS company_profile_snapshots_turn_fk_idx
ON company_profile_snapshots (turn_id);
