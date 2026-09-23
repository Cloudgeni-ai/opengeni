-- deployment-mode: rolling
-- Keep MCP OAuth callback context server-side; provider-facing state is a short reference.
CREATE TABLE integration_oauth_pending_states (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  state_encrypted text NOT NULL CHECK (octet_length(state_encrypted) BETWEEN 1 AND 32768),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_oauth_pending_states_workspace_account_fk
    FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
CREATE INDEX integration_oauth_pending_states_expiry_idx
  ON integration_oauth_pending_states (workspace_id, expires_at);
ALTER TABLE integration_oauth_pending_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_oauth_pending_states FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_oauth_pending_states_workspace_scope
  ON integration_oauth_pending_states
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
REVOKE ALL ON TABLE integration_oauth_pending_states FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON integration_oauth_pending_states TO opengeni_app;
  END IF;
END $$;
