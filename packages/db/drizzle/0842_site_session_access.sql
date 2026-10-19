-- deployment-mode: rolling
-- Explicit console-only access does not rewrite a conversation's origin or audience.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE site_session_access (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  site_id uuid NOT NULL,
  session_id uuid NOT NULL,
  owner_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, site_id, session_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE
);
ALTER TABLE site_session_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_session_access FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON site_session_access
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY owner_isolation ON site_session_access AS RESTRICTIVE
  USING (owner_subject_id IN (
    nullif(current_setting('opengeni.subject_id', true), ''),
    nullif(current_setting('opengeni.initiating_human_subject_id', true), '')
  ))
  WITH CHECK (owner_subject_id IN (
    nullif(current_setting('opengeni.subject_id', true), ''),
    nullif(current_setting('opengeni.initiating_human_subject_id', true), '')
  ) AND EXISTS (
    SELECT 1 FROM sessions s JOIN workspace_artifacts a ON a.workspace_id=s.workspace_id
    WHERE s.workspace_id=site_session_access.workspace_id AND s.id=site_session_access.session_id
      AND a.id=site_session_access.site_id AND a.visibility='user_private'
      AND s.site_access_root_id IS NULL
      AND s.owner_subject_id=site_session_access.owner_subject_id
      AND a.owner_subject_id=site_session_access.owner_subject_id
  ));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON site_session_access TO opengeni_app;
  END IF;
END $$;
