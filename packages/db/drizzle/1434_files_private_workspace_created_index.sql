-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS files_private_workspace_created_idx
ON files (workspace_id, (private_owner_subject_ids[1]), status, created_at, id)
WHERE private_owner_subject_ids IS NOT NULL;
