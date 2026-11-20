-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS agent_revisions_agent_config_hash_uq
ON agent_revisions (agent_id, config_hash)
WHERE config_hash IS NOT NULL;
