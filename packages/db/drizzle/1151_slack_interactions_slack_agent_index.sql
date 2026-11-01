-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS slack_interactions_slack_agent_idx
ON slack_interactions (slack_agent_id, created_at DESC)
WHERE slack_agent_id IS NOT NULL;
