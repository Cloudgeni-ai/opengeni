-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: event_sources holds a few rows per workspace, so validating in this file is instant.
-- A workspace MCP event source listens to a server by URL and is signed in by
-- the workspace credential provider, so it has no owner. Every other MCP
-- source keeps its owner. Only adds a column and widens the shape check:
-- every existing row already satisfies it, and older binaries never write
-- the column.
ALTER TABLE event_sources ADD COLUMN IF NOT EXISTS mcp_server_url text;

ALTER TABLE event_sources ADD CONSTRAINT event_sources_mcp_server_url_check CHECK (
  mcp_server_url IS NULL OR (
    kind = 'mcp'
    AND owner_subject_id IS NULL
    AND visibility = 'workspace'
    AND connection_id IS NULL
    AND mcp_server_url LIKE 'https://%'
    AND pg_catalog.octet_length(mcp_server_url) <= 2048
  )
) NOT VALID;
ALTER TABLE event_sources VALIDATE CONSTRAINT event_sources_mcp_server_url_check;

ALTER TABLE event_sources DROP CONSTRAINT event_sources_shape_chk;
ALTER TABLE event_sources ADD CONSTRAINT event_sources_shape_chk CHECK (
  ((kind = 'webhook') = (adapter IS NOT NULL))
  AND (
    kind <> 'webhook'
    OR secret_encrypted IS NOT NULL
    OR (adapter IN ('linear', 'sentry', 'custom') AND status <> 'active')
  )
  AND ((kind = 'mcp') = (mcp_server_id IS NOT NULL))
  AND (kind NOT IN ('github', 'slack', 'gmail') OR external_key IS NOT NULL)
  AND (kind NOT IN ('webhook', 'gmail', 'workspace') OR owner_subject_id IS NOT NULL)
  AND (kind <> 'mcp' OR owner_subject_id IS NOT NULL OR mcp_server_url IS NOT NULL)
  AND (kind <> 'workspace' OR visibility = 'private')
  AND ((status = 'active') = (status_reason IS NULL))
) NOT VALID;
ALTER TABLE event_sources VALIDATE CONSTRAINT event_sources_shape_chk;
