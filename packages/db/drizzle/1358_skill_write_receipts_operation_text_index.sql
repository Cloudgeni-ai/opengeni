-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS skill_write_receipts_operation_text_idx
  ON skill_write_receipts (workspace_id, (operation_id::text));
