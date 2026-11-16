-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS connections_live_account_identity_uq
ON connections (account_id, (coalesce(subject_id, workspace_id::text)), account_identity_key)
WHERE account_identity_key IS NOT NULL AND status <> 'revoked';
