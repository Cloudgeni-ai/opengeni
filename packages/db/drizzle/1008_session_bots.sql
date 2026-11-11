-- deployment-mode: rolling
-- Bots. Any chat may carry a one-line description and an avatar next to its
-- title: display metadata for people, never part of the model's context.
-- Both columns are nullable and additive; older binaries never read or write
-- them. The fork routines (0855) start from the complete source row, so a
-- fork keeps them like the title.
--
-- Bot templates are where a new bot chat starts: a name, description, avatar
-- and the setup instructions that become its first message. Everyone in the
-- workspace reads them; who may change or delete one (whoever saved it, or an
-- admin) is decided by the API. New code owns the table; old binaries never
-- read it.
SET LOCAL lock_timeout = '5s';

-- Every existing row is NULL, so the bounds are added NOT VALID: they hold
-- for every new write without scanning the table under its lock. IF NOT
-- EXISTS lets historical test fixtures stage the two columns early (their
-- current session writers name them) and still migrate forward.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS avatar jsonb;
ALTER TABLE sessions ADD CONSTRAINT sessions_description_bounds
  CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 280) NOT VALID;
ALTER TABLE sessions ADD CONSTRAINT sessions_avatar_bounds
  CHECK (avatar IS NULL OR (jsonb_typeof(avatar) = 'object' AND octet_length(avatar::text) <= 1024))
  NOT VALID;

CREATE TABLE bot_templates (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 280),
  avatar jsonb
    CHECK (avatar IS NULL OR (jsonb_typeof(avatar) = 'object' AND octet_length(avatar::text) <= 1024)),
  setup_instructions text NOT NULL CHECK (char_length(setup_instructions) BETWEEN 1 AND 20000),
  source_session_id uuid,
  created_by_subject_id text
    CHECK (created_by_subject_id IS NULL OR length(created_by_subject_id) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
CREATE INDEX bot_templates_workspace_idx ON bot_templates(workspace_id, created_at);
ALTER TABLE bot_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON bot_templates
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
REVOKE ALL ON TABLE bot_templates FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON bot_templates TO opengeni_app;
  END IF;
END $$;
