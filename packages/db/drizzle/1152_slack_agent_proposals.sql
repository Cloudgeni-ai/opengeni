-- deployment-mode: rolling
-- Creating Slack agents from Slack, and the Ask form.
--
-- slack_agent_proposals: a chat proposed an agent and posted a confirmation
-- card in its Slack thread. A click on Create or Cancel is checked against
-- this row, never against the button payload. HOME tenancy, like
-- slack_agents: the installation that posted the card owns the row.
--
-- slack_ask_forms: the message a person opened the Ask form on with the
-- message shortcut, kept until they submit it. Slack's private_metadata is too
-- small for a long message, so the form carries only this row's id.
--
-- Only new tables that the previous release never reads or writes.
CREATE TABLE slack_agent_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  slack_team_id text NOT NULL,
  target_account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  target_workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  proposed_by_session_id uuid NOT NULL,
  proposed_by_slack_user_id text,
  slack_channel_id text NOT NULL,
  slack_thread_ts text NOT NULL,
  slack_message_ts text,
  message_operation_id uuid NOT NULL,
  name text NOT NULL,
  name_key text NOT NULL,
  description text NOT NULL,
  avatar jsonb NOT NULL,
  instructions text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  created_slack_agent_id uuid REFERENCES slack_agents(id) ON DELETE SET NULL,
  decided_by_subject_id text,
  decided_by_slack_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_agent_proposals_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT slack_agent_proposals_target_workspace_account_fk
    FOREIGN KEY (target_workspace_id, target_account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT slack_agent_proposals_same_account_check CHECK (target_account_id = account_id),
  CONSTRAINT slack_agent_proposals_status_check CHECK (
    status IN ('pending', 'creating', 'created', 'cancelled')
  ),
  CONSTRAINT slack_agent_proposals_bounds_check CHECK (
    octet_length(slack_team_id) BETWEEN 1 AND 64
    AND (proposed_by_slack_user_id IS NULL OR octet_length(proposed_by_slack_user_id) BETWEEN 1 AND 64)
    AND octet_length(slack_channel_id) BETWEEN 1 AND 64
    AND octet_length(slack_thread_ts) BETWEEN 1 AND 64
    AND (slack_message_ts IS NULL OR octet_length(slack_message_ts) BETWEEN 1 AND 64)
    AND char_length(btrim(name)) BETWEEN 1 AND 80
    AND char_length(name_key) BETWEEN 1 AND 80
    AND char_length(btrim(description)) BETWEEN 1 AND 200
    AND jsonb_typeof(avatar) = 'object'
    AND pg_column_size(avatar) <= 4096
    AND char_length(instructions) <= 8000
    AND (decided_by_subject_id IS NULL OR octet_length(decided_by_subject_id) BETWEEN 1 AND 1024)
    AND (decided_by_slack_user_id IS NULL OR octet_length(decided_by_slack_user_id) BETWEEN 1 AND 64)
  )
);
CREATE INDEX slack_agent_proposals_workspace_idx ON slack_agent_proposals (workspace_id);
CREATE INDEX slack_agent_proposals_target_idx ON slack_agent_proposals (target_workspace_id);
CREATE INDEX slack_agent_proposals_created_agent_idx
  ON slack_agent_proposals (created_slack_agent_id)
  WHERE created_slack_agent_id IS NOT NULL;

ALTER TABLE slack_agent_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_agent_proposals FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE slack_agent_proposals FROM PUBLIC;
CREATE POLICY workspace_isolation ON slack_agent_proposals
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

COMMENT ON TABLE slack_agent_proposals IS 'Slack agents a chat proposed from Slack, awaiting a workspace admin''s Create on the card.';

CREATE TABLE slack_ask_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  slack_team_id text NOT NULL,
  slack_user_id text NOT NULL,
  slack_channel_id text NOT NULL,
  slack_message_ts text NOT NULL,
  slack_thread_ts text,
  provider_event_id text NOT NULL,
  message_text text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_ask_forms_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT slack_ask_forms_bounds_check CHECK (
    octet_length(slack_team_id) BETWEEN 1 AND 64
    AND octet_length(slack_user_id) BETWEEN 1 AND 64
    AND octet_length(slack_channel_id) BETWEEN 1 AND 64
    AND octet_length(slack_message_ts) BETWEEN 1 AND 64
    AND (slack_thread_ts IS NULL OR octet_length(slack_thread_ts) BETWEEN 1 AND 64)
    AND octet_length(provider_event_id) BETWEEN 1 AND 300
    AND octet_length(message_text) BETWEEN 1 AND 32000
  )
);
CREATE INDEX slack_ask_forms_expiry_idx ON slack_ask_forms (connection_id, expires_at);

ALTER TABLE slack_ask_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_ask_forms FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE slack_ask_forms FROM PUBLIC;
CREATE POLICY workspace_isolation ON slack_ask_forms
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

COMMENT ON TABLE slack_ask_forms IS 'The message an open Ask form was started on from the message shortcut, until it is submitted or expires.';

DO $slack_agent_proposals_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON slack_agent_proposals TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON slack_ask_forms TO opengeni_app;
  END IF;
END
$slack_agent_proposals_grants$;
