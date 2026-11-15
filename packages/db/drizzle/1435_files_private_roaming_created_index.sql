-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS files_private_roaming_created_idx
ON files (account_id, (private_owner_subject_ids[1]), status, created_at, id)
WHERE private_owner_subject_ids IS NOT NULL
  AND (reach_workspace_ids IS NULL OR cardinality(reach_workspace_ids) > 0);
