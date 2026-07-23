-- deployment-mode: rolling
-- A session-scoped MCP server may point at a host-owned connection. The value
-- is non-secret and remains inert unless the standalone broker or an embedding
-- host credential port resolves it at request time.

ALTER TABLE "session_mcp_servers"
  ADD COLUMN IF NOT EXISTS "connection_ref" jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_mcp_servers_connection_ref_object_chk'
      AND conrelid = 'session_mcp_servers'::regclass
  ) THEN
    ALTER TABLE "session_mcp_servers"
      ADD CONSTRAINT "session_mcp_servers_connection_ref_object_chk"
      CHECK (
        "connection_ref" IS NULL
        OR (
          jsonb_typeof("connection_ref") = 'object'
          AND COALESCE(jsonb_typeof("connection_ref"->'providerDomain') = 'string', false)
          AND COALESCE(length("connection_ref"->>'providerDomain') > 0, false)
        )
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE "session_mcp_servers"
  VALIDATE CONSTRAINT "session_mcp_servers_connection_ref_object_chk";
