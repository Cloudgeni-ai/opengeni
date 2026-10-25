-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS image_generation_operations_credit_hold_idx
ON image_generation_operations (workspace_id, provider_started_at)
WHERE credit_state = 'pending' AND status = 'provider_started';
