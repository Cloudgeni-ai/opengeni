-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_events_tool_call_page_idx
ON session_events (workspace_id, session_id, tool_call_id, sequence)
WHERE type IN ('agent.toolCall.created', 'agent.toolCall.output')
  AND tool_call_id IS NOT NULL AND octet_length(tool_call_id) <= 2048;
