-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
-- One version per config hash per organization agent (1502): a deploy or an
-- inline config that matches an existing version reuses it. Every existing
-- row has a NULL config_hash.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS agent_revisions_agent_config_hash_uq
ON agent_revisions (agent_id, config_hash)
WHERE config_hash IS NOT NULL;
