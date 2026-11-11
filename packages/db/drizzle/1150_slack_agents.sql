-- deployment-mode: rolling
-- online-safety-exception: nonconcurrent-index: slack_route_prompt_options holds at most five rows per first-use picker card, so rebuilding its one unique index is instant.
-- online-safety-exception: table-rewrite: the replaced UNIQUE is on slack_route_prompt_options, a small table of first-use picker card options, so building it scans only a few rows.
-- Slack agents: named teammates people call through the one Opengeni Slack
-- app. An agent belongs to one Slack installation (HOME, like
-- slack_channel_routes) and always works in one fixed TARGET workspace in the
-- same organization. Deleting the target workspace deletes its agents, and
-- deleting an agent deletes the channel settings that point at it.
--
-- Only new tables and new nullable columns that the previous release never
-- reads or writes, so an older binary keeps working unchanged.
CREATE TABLE slack_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  slack_team_id text NOT NULL,
  target_account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  target_workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  name_key text NOT NULL,
  description text NOT NULL,
  avatar jsonb NOT NULL,
  instructions text NOT NULL DEFAULT '',
  knowledge_collection_id uuid,
  open boolean NOT NULL DEFAULT false,
  created_by_subject_id text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_agents_name_key_uq UNIQUE (connection_id, name_key),
  CONSTRAINT slack_agents_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT slack_agents_target_workspace_account_fk
    FOREIGN KEY (target_workspace_id, target_account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT slack_agents_same_account_check CHECK (target_account_id = account_id),
  CONSTRAINT slack_agents_bounds_check CHECK (
    octet_length(slack_team_id) BETWEEN 1 AND 64
    AND char_length(btrim(name)) BETWEEN 1 AND 80
    AND name_key ~ '^[^[:space:]-]{1,80}$'
    AND char_length(btrim(description)) BETWEEN 1 AND 200
    AND jsonb_typeof(avatar) = 'object'
    AND pg_column_size(avatar) <= 4096
    AND char_length(instructions) <= 8000
    AND octet_length(created_by_subject_id) BETWEEN 1 AND 1024
    AND version > 0
  )
);
CREATE INDEX slack_agents_target_idx ON slack_agents (target_workspace_id);
CREATE INDEX slack_agents_account_idx ON slack_agents (account_id);

ALTER TABLE slack_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_agents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE slack_agents FROM PUBLIC;
-- Writes and installation reads use the installation's HOME tenancy.
CREATE POLICY workspace_isolation ON slack_agents
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
-- Everyone in the organization can see the agent directory, and a routed
-- chat reads its own agent from the target workspace. Read only.
CREATE POLICY slack_agents_organization_read ON slack_agents
  FOR SELECT
  USING (account_id = opengeni_private.current_account_id());

COMMENT ON TABLE slack_agents IS 'Named Slack agents of one Slack installation; home tenancy owns the row, the target workspace runs its chats.';

-- Per person and agent: the one-time "next time" hint and first use.
CREATE TABLE slack_agent_user_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  slack_agent_id uuid NOT NULL REFERENCES slack_agents(id) ON DELETE CASCADE,
  slack_user_id text NOT NULL,
  hint_interaction_id uuid,
  first_used_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_agent_user_states_agent_user_uq UNIQUE (slack_agent_id, slack_user_id),
  CONSTRAINT slack_agent_user_states_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT slack_agent_user_states_bounds_check CHECK (
    octet_length(slack_user_id) BETWEEN 1 AND 64
  )
);
CREATE INDEX slack_agent_user_states_user_idx
  ON slack_agent_user_states (connection_id, slack_user_id);

ALTER TABLE slack_agent_user_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_agent_user_states FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE slack_agent_user_states FROM PUBLIC;
CREATE POLICY workspace_isolation ON slack_agent_user_states
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $slack_agents_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON slack_agents TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON slack_agent_user_states TO opengeni_app;
  END IF;
END
$slack_agents_grants$;

-- A channel's "who answers" setting may name an agent. Deleting the agent
-- deletes the setting, so the channel asks again. The foreign keys below stay
-- NOT VALID: their columns are new, so every existing row is NULL, and
-- validating would only scan the table under this file's locks. They are
-- enforced for every new or changed row either way.
ALTER TABLE slack_channel_routes ADD COLUMN IF NOT EXISTS slack_agent_id uuid;
ALTER TABLE slack_channel_routes
  ADD CONSTRAINT slack_channel_routes_slack_agent_fk
  FOREIGN KEY (slack_agent_id) REFERENCES slack_agents(id) ON DELETE CASCADE NOT VALID;

-- The agent a chat was started for, frozen when its thread is bound. The
-- handoff column records who passed the thread on, so a chat never hands
-- back, and the last message columns say which message it is answering, so
-- one message moves at most once and the right person is checked.
ALTER TABLE slack_interactions ADD COLUMN IF NOT EXISTS slack_agent_id uuid;
ALTER TABLE slack_interactions ADD COLUMN IF NOT EXISTS handoff_from_slack_agent_id uuid;
ALTER TABLE slack_interactions ADD COLUMN IF NOT EXISTS last_inbound_provider_event_id text;
ALTER TABLE slack_interactions ADD COLUMN IF NOT EXISTS last_inbound_slack_user_id text;
ALTER TABLE slack_interactions
  ADD CONSTRAINT slack_interactions_slack_agent_fk
  FOREIGN KEY (slack_agent_id) REFERENCES slack_agents(id) ON DELETE SET NULL NOT VALID;

-- A picker option and a queued request may name an agent. No foreign key, like
-- the inbox's other routing columns: the agent is rechecked when it is used.
ALTER TABLE slack_route_prompt_options ADD COLUMN IF NOT EXISTS candidate_slack_agent_id uuid;
ALTER TABLE slack_interaction_inbox ADD COLUMN IF NOT EXISTS target_slack_agent_id uuid;
ALTER TABLE slack_interaction_inbox ADD COLUMN IF NOT EXISTS handoff_from_interaction_id uuid;
ALTER TABLE slack_interaction_inbox ADD COLUMN IF NOT EXISTS handoff_from_slack_agent_id uuid;

-- Per-person switch for occasional update messages about new agents.
ALTER TABLE slack_bot_user_links ADD COLUMN IF NOT EXISTS updates_muted_at timestamptz;

-- A picker card may offer a Slack agent and Opengeni in the agent's own
-- workspace, so an option is unique per workspace and agent, not per
-- workspace. Rows an older binary writes have no agent and stay unique.
ALTER TABLE slack_route_prompt_options
  DROP CONSTRAINT IF EXISTS slack_route_prompt_options_prompt_workspace_uq;
ALTER TABLE slack_route_prompt_options
  ADD CONSTRAINT slack_route_prompt_options_prompt_choice_uq
  UNIQUE NULLS NOT DISTINCT (prompt_id, candidate_workspace_id, candidate_slack_agent_id);
