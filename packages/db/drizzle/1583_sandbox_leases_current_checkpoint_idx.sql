-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS sandbox_leases_current_checkpoint_idx ON sandbox_leases (current_checkpoint_artifact_id) WHERE current_checkpoint_artifact_id IS NOT NULL;
