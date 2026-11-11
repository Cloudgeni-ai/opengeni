-- deployment-mode: rolling
-- Teams workspace routing (expand). A connected tenant reaches the workspaces
-- of its organization the linked person can start work in, as Slack does,
-- instead of only the installation's workspace and the person's Personal
-- workspace. Everything here is home tenancy: the rows live in the
-- installation's workspace, like its links and routes, and name a target
-- workspace of the same organization. A stored choice is memory, never
-- authority: the API re-checks the person's live access to the target on
-- enqueue, at session admission and on delivery.
--
--   1. teams_bot_installations.reach_*: where an organization admin lets
--      Teams start work. NULL workspace ids means every workspace of the
--      organization (the default); an array narrows it to those (the
--      installation's own workspace always stays). Personal workspaces are a
--      separate switch. Same semantics as the Slack bot's "Available in
--      Opengeni" setting, and edited with the same control.
--   2. teams_bot_routes.agent_id: the agent a 1:1 route's chat runs as. Part
--      of the route id, so each (person, workspace, agent) keeps its own chat.
--      Only a 1:1 route can name one.
--   3. teams_bot_chat_choices: the workspace (and agent) a person's 1:1 chat
--      uses, set by "switch" or by addressing an agent. One per Teams person.
--   4. teams_bot_route_prompts and _options: the choices a "switch" card
--      offered, and the message waiting for the answer when Opengeni had to
--      ask. The option number is what the person sends back; it is never
--      authority.
-- Every new target column has a same-account CHECK and a composite foreign
-- key to workspaces(id, account_id), as Slack's route tables do.
--
-- Rolling: new columns are nullable or have constant defaults, and new tables
-- are unknown to the previous release, which never reads or writes them. The
-- new behaviour is behind OPENGENI_TEAMS_WORKSPACE_ROUTING_ENABLED (off), and
-- a previous binary that drains a routed 1:1 chat refuses it at admission
-- (it only admits the person's own Personal workspace), so nothing is shared.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE teams_bot_installations
  ADD COLUMN reach_workspace_ids uuid[],
  ADD COLUMN reach_personal_workspaces boolean NOT NULL DEFAULT true,
  ADD COLUMN reach_version bigint NOT NULL DEFAULT 1;
ALTER TABLE teams_bot_installations ADD CONSTRAINT teams_bot_installations_reach_check
  CHECK ((reach_workspace_ids IS NULL OR (cardinality(reach_workspace_ids) <= 1000
      AND array_position(reach_workspace_ids, NULL) IS NULL))
    AND reach_version >= 1) NOT VALID;

ALTER TABLE teams_bot_routes ADD COLUMN agent_id uuid;
ALTER TABLE teams_bot_routes ADD CONSTRAINT teams_bot_routes_agent_check
  CHECK (agent_id IS NULL OR (personal AND channel_id IS NULL AND group_audience IS NULL))
  NOT VALID;
-- The agent is one of the route's organization; a deleted agent leaves the
-- route (and its pending replies) as a plain chat.
ALTER TABLE teams_bot_routes ADD CONSTRAINT teams_bot_routes_agent_fkey
  FOREIGN KEY (agent_id, account_id) REFERENCES agents(id, account_id)
  ON DELETE SET NULL (agent_id) NOT VALID;

CREATE TABLE teams_bot_chat_choices (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  subject_id text NOT NULL,
  target_account_id uuid NOT NULL,
  target_workspace_id uuid NOT NULL,
  agent_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor_id),
  CONSTRAINT teams_bot_chat_choices_same_account_check CHECK (target_account_id = account_id),
  CONSTRAINT teams_bot_chat_choices_bounds_check
    CHECK (length(subject_id) BETWEEN 1 AND 512 AND version > 0),
  CONSTRAINT teams_bot_chat_choices_link_fkey FOREIGN KEY (tenant_id, actor_id)
    REFERENCES teams_bot_links(tenant_id, actor_id) ON DELETE CASCADE,
  CONSTRAINT teams_bot_chat_choices_workspace_account_fkey FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT teams_bot_chat_choices_target_workspace_account_fkey
    FOREIGN KEY (target_workspace_id, target_account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT teams_bot_chat_choices_agent_fkey FOREIGN KEY (agent_id, target_account_id)
    REFERENCES agents(id, account_id) ON DELETE CASCADE
);
CREATE INDEX teams_bot_chat_choices_target_idx
  ON teams_bot_chat_choices (target_workspace_id);
CREATE INDEX teams_bot_chat_choices_agent_idx
  ON teams_bot_chat_choices (agent_id) WHERE agent_id IS NOT NULL;
COMMENT ON TABLE teams_bot_chat_choices IS 'The workspace and agent a linked Teams person''s 1:1 chat uses; memory, re-authorized on every message.';

CREATE TABLE teams_bot_route_prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  subject_id text NOT NULL,
  generation uuid NOT NULL,
  -- The message waiting for the answer, or null for a plain "switch".
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT teams_bot_route_prompts_actor_uq UNIQUE (tenant_id, actor_id),
  CONSTRAINT teams_bot_route_prompts_id_account_uq UNIQUE (id, account_id),
  CONSTRAINT teams_bot_route_prompts_bounds_check
    CHECK (length(subject_id) BETWEEN 1 AND 512
      AND (payload IS NULL OR octet_length(payload::text) <= 65536)),
  CONSTRAINT teams_bot_route_prompts_link_fkey FOREIGN KEY (tenant_id, actor_id)
    REFERENCES teams_bot_links(tenant_id, actor_id) ON DELETE CASCADE,
  CONSTRAINT teams_bot_route_prompts_workspace_account_fkey FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
CREATE INDEX teams_bot_route_prompts_created_idx ON teams_bot_route_prompts (created_at);
COMMENT ON TABLE teams_bot_route_prompts IS 'A Teams switch card a person was shown, with the message waiting for their choice.';

CREATE TABLE teams_bot_route_prompt_options (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  prompt_id uuid NOT NULL,
  position smallint NOT NULL,
  target_account_id uuid NOT NULL,
  target_workspace_id uuid NOT NULL,
  agent_id uuid,
  PRIMARY KEY (prompt_id, position),
  CONSTRAINT teams_bot_route_prompt_options_same_account_check
    CHECK (target_account_id = account_id),
  CONSTRAINT teams_bot_route_prompt_options_position_check CHECK (position BETWEEN 1 AND 100),
  CONSTRAINT teams_bot_route_prompt_options_prompt_fkey FOREIGN KEY (prompt_id, account_id)
    REFERENCES teams_bot_route_prompts(id, account_id) ON DELETE CASCADE,
  CONSTRAINT teams_bot_route_prompt_options_workspace_account_fkey
    FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT teams_bot_route_prompt_options_target_workspace_account_fkey
    FOREIGN KEY (target_workspace_id, target_account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT teams_bot_route_prompt_options_agent_fkey FOREIGN KEY (agent_id, target_account_id)
    REFERENCES agents(id, account_id) ON DELETE CASCADE
);
CREATE INDEX teams_bot_route_prompt_options_target_idx
  ON teams_bot_route_prompt_options (target_workspace_id);
CREATE INDEX teams_bot_route_prompt_options_agent_idx
  ON teams_bot_route_prompt_options (agent_id) WHERE agent_id IS NOT NULL;
COMMENT ON TABLE teams_bot_route_prompt_options IS 'The numbered workspaces and agents one Teams switch card offered.';

ALTER TABLE teams_bot_chat_choices ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams_bot_chat_choices FORCE ROW LEVEL SECURITY;
ALTER TABLE teams_bot_route_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams_bot_route_prompts FORCE ROW LEVEL SECURITY;
ALTER TABLE teams_bot_route_prompt_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams_bot_route_prompt_options FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE teams_bot_chat_choices FROM PUBLIC;
REVOKE ALL ON TABLE teams_bot_route_prompts FROM PUBLIC;
REVOKE ALL ON TABLE teams_bot_route_prompt_options FROM PUBLIC;
CREATE POLICY workspace_isolation ON teams_bot_chat_choices
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON teams_bot_route_prompts
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON teams_bot_route_prompt_options
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $teams_workspace_routing_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON teams_bot_chat_choices TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON teams_bot_route_prompts TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON teams_bot_route_prompt_options TO opengeni_app;
  END IF;
END
$teams_workspace_routing_grants$;
