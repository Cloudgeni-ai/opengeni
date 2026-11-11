-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_events_secret_used_idx
ON audit_events (workspace_id, occurred_at)
WHERE action = 'vault.secret.used';
