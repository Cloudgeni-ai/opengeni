-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS teams_bot_routes_session_workspace
ON teams_bot_routes USING btree (session_workspace_id, session_id)
WHERE session_workspace_id IS NOT NULL;
