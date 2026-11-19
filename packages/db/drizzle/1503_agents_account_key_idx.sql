-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS agents_account_key_uq
ON agents (account_id, agent_key)
WHERE agent_key IS NOT NULL;
