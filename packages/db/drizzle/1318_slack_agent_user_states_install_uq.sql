-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS slack_agent_user_states_install_user_uq
ON slack_agent_user_states (connection_id, slack_agent_id, slack_user_id);
