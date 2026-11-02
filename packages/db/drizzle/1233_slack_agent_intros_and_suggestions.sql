-- deployment-mode: rolling
-- Slack agents: one announcement channel, a record of intro posts, and the
-- "Ask <Agent>" suggestion a chat may show after its answer.
--
-- * slack_agent_update_settings.announcement_channel_id: where an
--   organization admin wants new agents introduced. A new nullable column the
--   previous release never reads or writes.
-- * slack_agent_intro_posts: one row per agent and channel its intro was
--   posted in, so the intro page shows which channels already have it.
-- * slack_agent_suggestions: one row per answered Slack message whose chat
--   suggested an agent. Delivery posts the suggestion after the answer, and
--   its button re-sends that message to the agent for whoever clicks it.
--
-- Both tables are HOME-owned (the installation binding's tenancy), like
-- slack_agent_user_states. Only new tables and a new column, so an older
-- binary keeps working unchanged.
ALTER TABLE slack_agent_update_settings ADD COLUMN IF NOT EXISTS announcement_channel_id text;

CREATE TABLE slack_agent_intro_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  slack_agent_id uuid NOT NULL REFERENCES slack_agents(id) ON DELETE CASCADE,
  slack_channel_id text NOT NULL,
  posted_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_agent_intro_posts_agent_channel_uq UNIQUE (slack_agent_id, slack_channel_id),
  CONSTRAINT slack_agent_intro_posts_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT slack_agent_intro_posts_bounds_check CHECK (
    octet_length(slack_channel_id) BETWEEN 1 AND 64
    AND octet_length(posted_by_subject_id) BETWEEN 1 AND 1024
  )
);

ALTER TABLE slack_agent_intro_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_agent_intro_posts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE slack_agent_intro_posts FROM PUBLIC;
CREATE POLICY workspace_isolation ON slack_agent_intro_posts
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

COMMENT ON TABLE slack_agent_intro_posts IS 'Channels a Slack agent''s intro was posted in.';

CREATE TABLE slack_agent_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  slack_agent_id uuid NOT NULL REFERENCES slack_agents(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  provider_event_id text NOT NULL,
  slack_team_id text NOT NULL,
  slack_user_id text NOT NULL,
  slack_channel_id text NOT NULL,
  slack_thread_ts text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_agent_suggestions_turn_uq UNIQUE (interaction_id, turn_id),
  CONSTRAINT slack_agent_suggestions_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT slack_agent_suggestions_bounds_check CHECK (
    octet_length(provider_event_id) BETWEEN 1 AND 512
    AND octet_length(slack_team_id) BETWEEN 1 AND 64
    AND octet_length(slack_user_id) BETWEEN 1 AND 64
    AND octet_length(slack_channel_id) BETWEEN 1 AND 64
    AND octet_length(slack_thread_ts) BETWEEN 1 AND 64
  )
);
CREATE INDEX slack_agent_suggestions_agent_idx ON slack_agent_suggestions (slack_agent_id);

ALTER TABLE slack_agent_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_agent_suggestions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE slack_agent_suggestions FROM PUBLIC;
CREATE POLICY workspace_isolation ON slack_agent_suggestions
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

COMMENT ON TABLE slack_agent_suggestions IS 'A Slack chat suggested asking a Slack agent after answering one Slack message.';

DO $slack_agent_intro_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON slack_agent_intro_posts TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON slack_agent_suggestions TO opengeni_app;
  END IF;
END
$slack_agent_intro_grants$;
