-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_history_items_tool_router_idx
ON session_history_items (workspace_id, session_id)
WHERE (
  item_ordered->>'type' IN ('tool_search_call', 'tool_search_output')
  OR (item_ordered->>'type' = 'function_call'
    AND item_ordered->>'name' IN ('tool_search', 'tool_list', 'tool_invoke'))
);
