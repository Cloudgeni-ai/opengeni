-- Per-session first-party MCP token permissions (manager-style sessions).
-- NULL means the fixed worker default permission set in @opengeni/runtime.
-- Values are validated at session creation: every permission must be held by
-- the creating grant, so a session can never out-rank its creator.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "first_party_mcp_permissions" jsonb;
