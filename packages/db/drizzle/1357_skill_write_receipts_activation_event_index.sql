-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS skill_write_receipts_activation_event_idx
  ON skill_write_receipts (account_id, activation_event_id);
