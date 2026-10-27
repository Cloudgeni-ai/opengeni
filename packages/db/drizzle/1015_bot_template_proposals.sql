-- deployment-mode: rolling
-- Bot templates learn from their bots. Older binaries never read the new
-- column or table.
--
-- sessions.bot_template_id: the bot template a chat was started from. A link
-- for proposals and display only; no foreign key, so a deleted template simply
-- leaves an unresolved id that readers ignore. Nullable column addition,
-- metadata-only.
--
-- bot_template_proposals: a bot chat may propose new setup instructions for
-- its template when its setup changed in a way new bots should get (a Skill,
-- connection, schedule or standing rule). The agent never applies one: a
-- person who may change the template accepts it, which updates the template.
-- Each proposal names the chat it came from, so like every other chat-linked
-- row it is visible only to someone who can see that chat.
SET LOCAL lock_timeout = '5s';

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS bot_template_id uuid;

CREATE TABLE bot_template_proposals (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  template_id uuid NOT NULL REFERENCES bot_templates(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  -- The template's updated_at the proposal was written against.
  base_updated_at timestamptz NOT NULL,
  setup_instructions text NOT NULL
    CHECK (char_length(setup_instructions) BETWEEN 1 AND 20000),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 400),
  proposed_by_subject_id text
    CHECK (proposed_by_subject_id IS NULL OR length(proposed_by_subject_id) BETWEEN 1 AND 512),
  status text NOT NULL DEFAULT 'pending',
  decided_by_subject_id text
    CHECK (decided_by_subject_id IS NULL OR length(decided_by_subject_id) BETWEEN 1 AND 512),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bot_template_proposals_status_chk
    CHECK ((status = 'pending' AND decided_at IS NULL)
      OR (status IN ('accepted', 'dismissed', 'superseded') AND decided_at IS NOT NULL)),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
CREATE INDEX bot_template_proposals_template_idx
  ON bot_template_proposals (workspace_id, template_id, status, created_at);
CREATE INDEX bot_template_proposals_session_idx
  ON bot_template_proposals (workspace_id, session_id, status);

ALTER TABLE bot_template_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_template_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON bot_template_proposals
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY session_visibility_isolation ON bot_template_proposals AS RESTRICTIVE
  FOR ALL USING (session_reference_visible(account_id, workspace_id, session_id))
  WITH CHECK (session_reference_visible(account_id, workspace_id, session_id));
REVOKE ALL ON TABLE bot_template_proposals FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE ON bot_template_proposals TO opengeni_app;
  END IF;
END $$;
