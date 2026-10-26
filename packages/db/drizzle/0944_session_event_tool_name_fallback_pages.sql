-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_events_tool_name_fallback_page_idx
ON session_events (workspace_id, session_id, sequence)
WHERE type = 'agent.toolCall.created'
  AND (tool_name IS NULL OR octet_length(tool_name) > 2048);
