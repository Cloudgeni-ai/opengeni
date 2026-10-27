-- deployment-mode: rolling
-- "Always allow for this Site": one person's standing consent for one Site to
-- run one tool on one of their own connections without the host confirmation.
-- Personal like site_sidebar_states: only its own subject reads or writes a
-- row. It never changes the connection-wide tool permission (which also
-- governs agents), never overrides Block, and is consulted only for calls
-- from that Site. New code owns the table; old binaries never read it.
CREATE TABLE site_tool_allowances (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 512),
  site_id uuid NOT NULL,
  -- The canonical connector, never an account route.
  server_id text NOT NULL CHECK (length(server_id) BETWEEN 1 AND 256),
  tool_name text NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 512),
  -- Empty for a tool without a connection (for example a first-party tool).
  connection_id text NOT NULL DEFAULT '' CHECK (length(connection_id) <= 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, subject_id, site_id, server_id, tool_name, connection_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX site_tool_allowances_site_idx ON site_tool_allowances(workspace_id, site_id);
ALTER TABLE site_tool_allowances ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_tool_allowances FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON site_tool_allowances
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND subject_id = opengeni_private.current_subject_id()
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND subject_id = opengeni_private.current_subject_id()
  );
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON site_tool_allowances TO opengeni_app;
  END IF;
END $$;
