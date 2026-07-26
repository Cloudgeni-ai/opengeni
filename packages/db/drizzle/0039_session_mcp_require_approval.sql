-- 0039_session_mcp_require_approval.sql
-- Per-session-MCP-server human-approval policy. jsonb holds either `true`
-- (every tool of the server requires approval) or a JSON array of UNPREFIXED
-- tool names (only those require it). NULL / absent = auto-run (the historical
-- default), so this is additive and backfill-free.

ALTER TABLE "session_mcp_servers" ADD COLUMN IF NOT EXISTS "require_approval" jsonb;
