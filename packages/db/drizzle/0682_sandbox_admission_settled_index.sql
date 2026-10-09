-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS sandbox_workspace_mutation_admissions_settled_idx
  ON sandbox_workspace_mutation_admissions (lease_id, settled_at)
  WHERE settled_at IS NOT NULL;
