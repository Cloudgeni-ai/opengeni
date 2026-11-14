-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS files_shared_created_idx
ON files (workspace_id, status, created_at, id)
WHERE private_owner_subject_ids IS NULL;
