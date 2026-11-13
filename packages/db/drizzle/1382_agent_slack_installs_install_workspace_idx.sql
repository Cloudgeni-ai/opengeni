-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_slack_installs_install_workspace_idx
ON agent_slack_installs (install_workspace_id);
