-- deployment-mode: rolling
-- Opt-in OAuth 2.1-style authorization-server state for exact workspace MCP
-- resources. Only hashes of authorization codes and bearer/refresh tokens are
-- retained; grants freeze permissions and tool identities for later live
-- intersection.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE mcp_oauth_clients (
  client_id text PRIMARY KEY CHECK (octet_length(client_id) BETWEEN 16 AND 256),
  redirect_uris jsonb NOT NULL CHECK (
    jsonb_typeof(redirect_uris) = 'array' AND jsonb_array_length(redirect_uris) BETWEEN 1 AND 16
  ),
  client_name text CHECK (client_name IS NULL OR octet_length(client_name) BETWEEN 1 AND 200),
  token_endpoint_auth_method text NOT NULL DEFAULT 'none' CHECK (token_endpoint_auth_method = 'none'),
  grant_types jsonb NOT NULL CHECK (jsonb_typeof(grant_types) = 'array'),
  response_types jsonb NOT NULL CHECK (response_types = '["code"]'::jsonb),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_oauth_clients_created_idx ON mcp_oauth_clients(created_at);

CREATE TABLE mcp_oauth_authorization_requests (
  request_hash text PRIMARY KEY CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  client_id text NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_id text NOT NULL CHECK (octet_length(subject_id) BETWEEN 1 AND 1024),
  resource text NOT NULL CHECK (octet_length(resource) BETWEEN 1 AND 2048),
  redirect_uri text NOT NULL CHECK (octet_length(redirect_uri) BETWEEN 1 AND 2048),
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  state text CHECK (state IS NULL OR octet_length(state) BETWEEN 1 AND 1024),
  permissions jsonb NOT NULL CHECK (jsonb_typeof(permissions) = 'array'),
  tool_identities jsonb NOT NULL CHECK (
    jsonb_typeof(tool_identities) = 'array' AND jsonb_array_length(tool_identities) <= 2048
  ),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mcp_oauth_authorization_requests
  ADD CONSTRAINT mcp_oauth_authorization_requests_workspace_account_fk
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;
CREATE INDEX mcp_oauth_authorization_requests_expires_idx
  ON mcp_oauth_authorization_requests(expires_at);

CREATE TABLE mcp_oauth_authorization_codes (
  code_hash text PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  client_id text NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_id text NOT NULL CHECK (octet_length(subject_id) BETWEEN 1 AND 1024),
  resource text NOT NULL CHECK (octet_length(resource) BETWEEN 1 AND 2048),
  redirect_uri text NOT NULL CHECK (octet_length(redirect_uri) BETWEEN 1 AND 2048),
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  permissions jsonb NOT NULL CHECK (jsonb_typeof(permissions) = 'array'),
  tool_identities jsonb NOT NULL CHECK (
    jsonb_typeof(tool_identities) = 'array' AND jsonb_array_length(tool_identities) <= 2048
  ),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mcp_oauth_authorization_codes
  ADD CONSTRAINT mcp_oauth_authorization_codes_workspace_account_fk
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;
CREATE INDEX mcp_oauth_authorization_codes_expires_idx
  ON mcp_oauth_authorization_codes(expires_at);

CREATE TABLE mcp_oauth_refresh_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  family_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  client_id text NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_id text NOT NULL CHECK (octet_length(subject_id) BETWEEN 1 AND 1024),
  resource text NOT NULL CHECK (octet_length(resource) BETWEEN 1 AND 2048),
  permissions jsonb NOT NULL CHECK (jsonb_typeof(permissions) = 'array'),
  tool_identities jsonb NOT NULL CHECK (
    jsonb_typeof(tool_identities) = 'array' AND jsonb_array_length(tool_identities) <= 2048
  ),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, generation)
);
ALTER TABLE mcp_oauth_refresh_tokens
  ADD CONSTRAINT mcp_oauth_refresh_tokens_workspace_account_fk
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;
CREATE INDEX mcp_oauth_refresh_tokens_expires_idx ON mcp_oauth_refresh_tokens(expires_at);

CREATE TABLE mcp_oauth_access_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  refresh_family_id uuid NOT NULL,
  refresh_generation integer NOT NULL CHECK (refresh_generation > 0),
  client_id text NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_id text NOT NULL CHECK (octet_length(subject_id) BETWEEN 1 AND 1024),
  resource text NOT NULL CHECK (octet_length(resource) BETWEEN 1 AND 2048),
  permissions jsonb NOT NULL CHECK (jsonb_typeof(permissions) = 'array'),
  tool_identities jsonb NOT NULL CHECK (
    jsonb_typeof(tool_identities) = 'array' AND jsonb_array_length(tool_identities) <= 2048
  ),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mcp_oauth_access_tokens
  ADD CONSTRAINT mcp_oauth_access_tokens_workspace_account_fk
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;
CREATE INDEX mcp_oauth_access_tokens_family_idx
  ON mcp_oauth_access_tokens(refresh_family_id, refresh_generation);
CREATE INDEX mcp_oauth_access_tokens_expires_idx ON mcp_oauth_access_tokens(expires_at);

REVOKE ALL ON mcp_oauth_clients, mcp_oauth_authorization_requests,
  mcp_oauth_authorization_codes, mcp_oauth_refresh_tokens, mcp_oauth_access_tokens FROM PUBLIC;

DO $application_grants$
DECLARE
  data_schema text := current_schema();
  application_role text;
BEGIN
  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
    UNION SELECT 'opengeni_app'
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %1$I.mcp_oauth_clients, %1$I.mcp_oauth_authorization_requests, %1$I.mcp_oauth_authorization_codes, %1$I.mcp_oauth_refresh_tokens, %1$I.mcp_oauth_access_tokens TO %2$I',
      data_schema, application_role
    );
  END LOOP;
END
$application_grants$;