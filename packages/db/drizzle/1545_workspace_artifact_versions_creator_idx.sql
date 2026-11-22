-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS workspace_artifact_versions_creator_idx
ON workspace_artifact_versions (workspace_id, created_by_subject_id, created_at DESC)
INCLUDE (artifact_id);
