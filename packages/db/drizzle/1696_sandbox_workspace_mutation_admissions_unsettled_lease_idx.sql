-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS sandbox_workspace_mutation_admissions_unsettled_lease_idx
ON sandbox_workspace_mutation_admissions (account_id, workspace_id, lease_id)
WHERE settled_at IS NULL;
