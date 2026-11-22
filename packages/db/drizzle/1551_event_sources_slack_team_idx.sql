-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS event_sources_slack_team_idx
ON event_sources (account_id, external_key, workspace_id)
WHERE kind = 'slack';
