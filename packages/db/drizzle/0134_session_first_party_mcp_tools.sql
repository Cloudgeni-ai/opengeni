-- deployment-mode: rolling
-- Per-session model-visible selection for the broad first-party MCP server.
-- NULL resolves to the fixed minimal default; [] intentionally selects none.
ALTER TABLE "sessions"
  ADD COLUMN "first_party_mcp_tools" jsonb;

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_first_party_mcp_tools_array_chk"
  CHECK (
    "first_party_mcp_tools" IS NULL
    OR jsonb_typeof("first_party_mcp_tools") = 'array'
  ) NOT VALID;

ALTER TABLE "sessions"
  VALIDATE CONSTRAINT "sessions_first_party_mcp_tools_array_chk";
