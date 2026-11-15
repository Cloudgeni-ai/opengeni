-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS slack_agent_intro_posts_install_channel_uq
ON slack_agent_intro_posts (connection_id, slack_agent_id, slack_channel_id);
