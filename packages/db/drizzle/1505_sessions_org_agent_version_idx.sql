-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
-- Console's chats per organization agent and version, and a publish that
-- moves running chats (1502). Only chats with an agent_version are indexed.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_org_agent_version_idx
ON sessions (account_id, agent_id, agent_version, created_at DESC)
WHERE agent_version IS NOT NULL;
