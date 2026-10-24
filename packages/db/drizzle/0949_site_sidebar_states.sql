-- deployment-mode: rolling
-- Each person's own sidebar state for a Site row: pinned to the top, or
-- archived (hidden from their sidebar). Like session pins it is personal and
-- grants nothing; the Site, its publication and its audience are unchanged.
-- New code owns the table; old binaries never read it.
CREATE TABLE site_sidebar_states (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 512),
  site_id uuid NOT NULL,
  pinned_at timestamptz,
  archived_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, subject_id, site_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX site_sidebar_states_site_idx ON site_sidebar_states(workspace_id, site_id);
ALTER TABLE site_sidebar_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_sidebar_states FORCE ROW LEVEL SECURITY;
-- Personal like session pins: only its own subject reads or writes a row.
CREATE POLICY workspace_isolation ON site_sidebar_states
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON site_sidebar_states TO opengeni_app;
  END IF;
END $$;
