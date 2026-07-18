-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY "sessions_workspace_root_depth_idx"
  ON "sessions" ("workspace_id", "root_session_id", "nested_agent_depth");