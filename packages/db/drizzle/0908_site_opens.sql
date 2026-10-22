-- deployment-mode: rolling
-- When each person last opened a Site in the console. It orders that
-- person's Site rows in the sidebar like session activity and grants
-- nothing: the Site's own audience still decides who can see it. New code
-- owns the table; old binaries never read it.
CREATE TABLE site_opens (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 512),
  site_id uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, subject_id, site_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX site_opens_site_idx ON site_opens(workspace_id, site_id);
ALTER TABLE site_opens ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_opens FORCE ROW LEVEL SECURITY;
-- Personal like session pins: only the opening subject reads or writes a row.
CREATE POLICY workspace_isolation ON site_opens
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON site_opens TO opengeni_app;
  END IF;
END $$;
