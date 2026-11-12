-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS teams_bot_routes_agent_idx
  ON teams_bot_routes (agent_id)
  WHERE agent_id IS NOT NULL;
