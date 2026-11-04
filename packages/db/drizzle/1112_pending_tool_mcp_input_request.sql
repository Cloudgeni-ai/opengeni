-- deployment-mode: rolling
-- An MCP server can ask the person a question in the middle of a tool call
-- (form elicitation). The paused call keeps the server's questions and its
-- opaque request state here, outside the session event log, until the person
-- answers and the call is retried. A nullable column without default or check
-- is a catalog-only change; the previous release never writes it.
ALTER TABLE session_pending_tool_calls
  ADD COLUMN IF NOT EXISTS mcp_input_request jsonb;
COMMENT ON COLUMN session_pending_tool_calls.mcp_input_request IS
  'Private state of an MCP server question that paused this call: server label, round, the form requests and the server''s opaque requestState. Never copied into events.';
