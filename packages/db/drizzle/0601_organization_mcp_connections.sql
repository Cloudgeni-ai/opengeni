-- deployment-mode: rolling
-- Organization MCP connections. An MCP OAuth grant may hold an organization
-- access setting (what the agent can do and where) instead of one workspace.
-- The person's live access still caps every request. Older binaries never
-- accept the organization resource, so they never serve these rows; rows they
-- write keep a workspace and no access setting.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE mcp_oauth_authorization_requests
  ALTER COLUMN workspace_id DROP NOT NULL,
  ADD COLUMN organization_access jsonb,
  ADD CONSTRAINT mcp_oauth_authorization_requests_target_check
    CHECK ((workspace_id IS NULL) <> (organization_access IS NULL));

ALTER TABLE mcp_oauth_authorization_codes
  ALTER COLUMN workspace_id DROP NOT NULL,
  ADD COLUMN organization_access jsonb,
  ADD CONSTRAINT mcp_oauth_authorization_codes_target_check
    CHECK ((workspace_id IS NULL) <> (organization_access IS NULL));

ALTER TABLE mcp_oauth_refresh_tokens
  ALTER COLUMN workspace_id DROP NOT NULL,
  ADD COLUMN organization_access jsonb,
  ADD COLUMN connected_at timestamptz,
  ADD CONSTRAINT mcp_oauth_refresh_tokens_target_check
    CHECK ((workspace_id IS NULL) <> (organization_access IS NULL));

ALTER TABLE mcp_oauth_access_tokens
  ALTER COLUMN workspace_id DROP NOT NULL,
  ADD COLUMN organization_access jsonb,
  ADD CONSTRAINT mcp_oauth_access_tokens_target_check
    CHECK ((workspace_id IS NULL) <> (organization_access IS NULL));

-- Connected agents are listed per organization.
CREATE INDEX mcp_oauth_refresh_tokens_organization_idx
  ON mcp_oauth_refresh_tokens (account_id, family_id)
  WHERE organization_access IS NOT NULL;