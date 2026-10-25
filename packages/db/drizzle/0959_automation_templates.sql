-- deployment-mode: rolling
-- Automation templates people save in a workspace, for anyone in it to start
-- an automation from. A template holds what an automation does and when (its
-- message, a schedule without a time zone, and event triggers that name a
-- kind of source); the server stores it and never turns it into an
-- automation itself. New code owns the table; old binaries never read it.
CREATE TABLE automation_templates (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  definition jsonb NOT NULL CHECK (
    jsonb_typeof(definition) = 'object' AND octet_length(definition::text) <= 262144
  ),
  created_by_subject_id text
    CHECK (created_by_subject_id IS NULL OR length(created_by_subject_id) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
CREATE INDEX automation_templates_workspace_idx ON automation_templates(workspace_id, created_at);
ALTER TABLE automation_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_templates FORCE ROW LEVEL SECURITY;
-- Shared with the workspace: everyone in it reads them. Who may change or
-- delete one (whoever saved it, or an admin) is decided by the API.
CREATE POLICY workspace_isolation ON automation_templates
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
REVOKE ALL ON TABLE automation_templates FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON automation_templates TO opengeni_app;
  END IF;
END $$;
