-- deployment-mode: rolling
-- A Site's project in the sidebar, chosen by a person. Without a row a Site
-- sits in the project of the chat that created it; a row overrides that for
-- everyone, like a chat's project (sessions.channel_id). A null channel_id is
-- the Default (no project). Deleting the project returns the Site to Default,
-- as it does for chats. Shared workspace state; it grants nothing and the
-- Site's audience still decides who sees the row. New code owns the table;
-- old binaries never read it.
CREATE TABLE site_project_placements (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  site_id uuid NOT NULL,
  channel_id uuid,
  placed_by_subject_id text NOT NULL CHECK (length(placed_by_subject_id) BETWEEN 1 AND 512),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, site_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) ON DELETE SET NULL (channel_id)
);
CREATE INDEX site_project_placements_channel_idx ON site_project_placements(workspace_id, channel_id);
ALTER TABLE site_project_placements ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_project_placements FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON site_project_placements
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON site_project_placements TO opengeni_app;
  END IF;
END $$;
