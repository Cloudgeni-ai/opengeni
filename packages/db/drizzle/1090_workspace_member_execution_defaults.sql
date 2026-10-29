-- deployment-mode: rolling
-- "Your default machine": one person's own placement for the new chats they
-- start in one workspace, ahead of the workspace default. Personal like
-- site_tool_allowances: only its own subject reads or writes a row. Session
-- creation validates the stored machine on every use and falls back to the
-- workspace default when it is no longer usable, so a removed machine or a
-- lost membership needs no cleanup. New code owns the table; old binaries
-- never read it.
CREATE TABLE workspace_member_execution_defaults (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 512),
  -- Same shape as workspaces.settings.defaultExecutionTarget.
  target jsonb NOT NULL CHECK (
    jsonb_typeof(target) = 'object'
    AND target->>'kind' IN ('managed', 'machine')
  ),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, subject_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
ALTER TABLE workspace_member_execution_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_member_execution_defaults FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON workspace_member_execution_defaults
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_member_execution_defaults TO opengeni_app;
  END IF;
END $$;
