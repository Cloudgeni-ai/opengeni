-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS sandbox_leases_previous_checkpoint_idx ON sandbox_leases (previous_checkpoint_artifact_id) WHERE previous_checkpoint_artifact_id IS NOT NULL;
