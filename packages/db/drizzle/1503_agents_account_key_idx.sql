-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
-- An organization agent's key is unique in its organization (1502). Every
-- existing row has a NULL agent_key, so the build never fails.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS agents_account_key_uq
ON agents (account_id, agent_key)
WHERE agent_key IS NOT NULL;
