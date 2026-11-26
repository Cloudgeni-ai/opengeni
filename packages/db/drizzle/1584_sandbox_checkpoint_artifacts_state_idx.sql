-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS sandbox_checkpoint_artifacts_state_idx ON sandbox_checkpoint_artifacts (state, deleted_at, id);
