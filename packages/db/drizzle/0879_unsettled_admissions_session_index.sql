-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS sandbox_workspace_mutation_admissions_unsettled_session_idx
ON sandbox_workspace_mutation_admissions (workspace_id, session_id)
WHERE settled_at IS NULL;
