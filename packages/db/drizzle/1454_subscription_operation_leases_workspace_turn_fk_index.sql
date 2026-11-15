-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS subscription_operation_leases_workspace_turn_fk_idx
ON subscription_operation_leases (workspace_id, turn_id);
