-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS mcp_oauth_refresh_tokens_trusted_issuer_idx
ON mcp_oauth_refresh_tokens (trusted_issuer_id, assertion_subject, client_id)
WHERE trusted_issuer_id IS NOT NULL;
