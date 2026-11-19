-- deployment-mode: rolling
-- Console agents (docs/agents.md, "Console agents"): organization agents with
-- numbered versions, organization tool servers, end users' stored tool
-- logins, and which version each chat runs. Expand step; the per-organization
-- flag OPENGENI_ORG_AGENTS_ACCOUNT_IDS is empty by default, so nothing writes
-- these shapes until an organization is turned on.
--
-- - agents: `scope` 'organization' rows have no home workspace
--   (workspace_id NULL) and a `agent_key` unique in the organization. Their
--   versions are agent_revisions rows (workspace_id NULL) that also carry the
--   version `config` (model, built-ins, tool servers, tools, approvals), the
--   servers' `tool_catalog` when saved, the `source` and a `config_hash` for
--   idempotent deploys. `published_revision` is the version new chats run.
--   `managed_by` is 'console' or 'code' (code deploys only).
-- - A restrictive policy hides organization rows unless the transaction sets
--   opengeni.org_agents_v1 = '1', which only this release's organization
--   agent code does. Slack placement, Teams routing, the app's agent list and
--   every other existing reader of agents therefore never see them, and the
--   previous release behaves exactly as before.
-- - A permissive policy lets the organization's own contexts (any workspace
--   of the account, or the account itself) read and write organization rows;
--   the API checks agents:read / agents:manage or organization
--   administration first. agent_revisions keeps its exact runtime grants
--   (SELECT, INSERT): when a version was published is recorded in
--   agent_publish_operations instead of on the revision.
-- - organization_tool_servers: MCP servers an organization's agents use.
--   The shared key and OAuth client secret are encrypted by the application.
-- - end_user_tool_credentials: one end user's login per managed workspace and
--   tool server, encrypted by the application, never returned by the API.
--   A workspace context sees its own rows; the account context sees the
--   organization's rows, so moving a tool server to another origin and
--   offboarding an end user delete their logins in every workspace at once.
-- - agent_workspace_access: workspaces an organization agent is available in
--   besides the organization's managed workspaces.
-- - agent_publish_operations: each publish or rollback, and whether it moved
--   running chats (and how many).
-- - sessions.agent_version: the organization agent version the chat runs;
--   sessions.agent_prompt_version: the version whose Instructions are in its
--   system prompt (a move delivers newer Instructions as history items);
--   sessions.agent_overrides: what the chat changed from that version.
-- - organization_managed_workspaces.source gains 'console_test' (the
--   organization's Console test workspace) and the Console audit log gains
--   agent and tool server actions. Both checks are re-added NOT VALID and
--   validated in 1506.
--
-- Rolling: the previous release never reads or writes the new columns or
-- tables, never sets opengeni.org_agents_v1, so it cannot see organization
-- rows, and only writes check values the widened checks still accept. Every
-- new check is NOT VALID (all existing rows satisfy it; 1506 validates).
-- A chat with an agent_version is refused to a previous worker by the claim
-- gate below, as 1276 does for agent_prompt_revision. The new tables are
-- FORCE RLS with exact runtime grants, which the previous release's readiness
-- accepts for unknown tables; the trigger function is SECURITY INVOKER.
SET LOCAL lock_timeout = '5s';

-- Organization agents ------------------------------------------------------

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'workspace',
  ADD COLUMN IF NOT EXISTS agent_key text,
  ADD COLUMN IF NOT EXISTS published_revision integer,
  ADD COLUMN IF NOT EXISTS managed_by text NOT NULL DEFAULT 'console',
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE agents ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE agents ADD CONSTRAINT agents_scope_check CHECK (
  (scope = 'workspace' AND workspace_id IS NOT NULL)
  OR (scope = 'organization' AND workspace_id IS NULL AND agent_key IS NOT NULL
    AND visibility = 'workspace')
) NOT VALID;
ALTER TABLE agents ADD CONSTRAINT agents_organization_fields_check CHECK (
  (agent_key IS NULL OR agent_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$')
  AND (published_revision IS NULL OR (published_revision > 0 AND published_revision <= current_revision))
  AND managed_by IN ('console', 'code')
) NOT VALID;
COMMENT ON COLUMN agents.scope IS 'workspace: a workspace agent (home workspace_id). organization: a Console agent with no home workspace, visible only when opengeni.org_agents_v1 = 1.';
COMMENT ON COLUMN agents.agent_key IS 'An organization agent''s key, unique in its organization (agents_account_key_uq).';
COMMENT ON COLUMN agents.published_revision IS 'The organization agent version new chats run; NULL until published.';
COMMENT ON COLUMN agents.managed_by IS 'console: edited in Console. code: deployed from YAML; Console is read-only.';

ALTER TABLE agent_revisions
  ADD COLUMN IF NOT EXISTS config jsonb,
  ADD COLUMN IF NOT EXISTS tool_catalog jsonb,
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS config_hash text;
ALTER TABLE agent_revisions ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE agent_revisions ADD CONSTRAINT agent_revisions_organization_fields_check CHECK (
  (config IS NULL OR (jsonb_typeof(config) = 'object' AND pg_column_size(config) <= 262144))
  AND (tool_catalog IS NULL OR (jsonb_typeof(tool_catalog) = 'object' AND pg_column_size(tool_catalog) <= 1048576))
  AND (source IS NULL OR source IN ('console', 'deploy', 'inline'))
  AND (config_hash IS NULL OR config_hash ~ '^sha256:[0-9a-f]{64}$')
  AND (workspace_id IS NOT NULL OR (config IS NOT NULL AND source IS NOT NULL AND config_hash IS NOT NULL))
) NOT VALID;
COMMENT ON COLUMN agent_revisions.config IS 'An organization agent version''s settings (OrgAgentVersionConfig); NULL for workspace agents.';

-- Organization rows are visible only to code that opts in.
CREATE POLICY agents_organization_scope_gate ON agents AS RESTRICTIVE
  USING (scope = 'workspace' OR current_setting('opengeni.org_agents_v1', true) = '1')
  WITH CHECK (scope = 'workspace' OR current_setting('opengeni.org_agents_v1', true) = '1');
CREATE POLICY agents_organization_scope ON agents
  USING (scope = 'organization' AND account_id = opengeni_private.current_account_id())
  WITH CHECK (scope = 'organization' AND account_id = opengeni_private.current_account_id());
-- Versions of an organization agent; agent_revisions_agent_visible (1243)
-- still requires the agent itself to be visible, so the gate carries over.
CREATE POLICY agent_revisions_organization_scope ON agent_revisions
  USING (workspace_id IS NULL AND account_id = opengeni_private.current_account_id())
  WITH CHECK (workspace_id IS NULL AND account_id = opengeni_private.current_account_id());

-- Organization tool servers ------------------------------------------------

CREATE TABLE organization_tool_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  server_key text NOT NULL,
  name text NOT NULL,
  url text NOT NULL,
  auth_mode text NOT NULL,
  shared_headers_encrypted text,
  shared_header_names text[] NOT NULL DEFAULT '{}',
  oauth_refresh jsonb,
  version integer NOT NULL DEFAULT 1,
  created_by_subject_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_tool_servers_key_uq UNIQUE (account_id, server_key),
  CONSTRAINT organization_tool_servers_id_account_uq UNIQUE (id, account_id),
  CONSTRAINT organization_tool_servers_bounds_check CHECK (
    server_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    AND char_length(btrim(name)) BETWEEN 1 AND 120
    AND url ~ '^https://' AND octet_length(url) <= 2048
    AND auth_mode IN ('per_user', 'shared_key', 'none')
    AND (auth_mode = 'shared_key' OR shared_headers_encrypted IS NULL)
    AND (shared_headers_encrypted IS NULL OR octet_length(shared_headers_encrypted) <= 131072)
    AND cardinality(shared_header_names) <= 64
    AND (oauth_refresh IS NULL OR (jsonb_typeof(oauth_refresh) = 'object' AND pg_column_size(oauth_refresh) <= 16384))
    AND (created_by_subject_id IS NULL OR char_length(created_by_subject_id) BETWEEN 1 AND 1024)
    AND version > 0
  )
);
COMMENT ON TABLE organization_tool_servers IS 'MCP servers an organization''s Console agents use. Secrets are encrypted by the application and never returned.';

-- End users' tool logins ---------------------------------------------------

CREATE TABLE end_user_tool_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES organization_managed_workspaces(workspace_id) ON DELETE CASCADE,
  end_user_subject_id text NOT NULL,
  tool_server_id uuid NOT NULL,
  kind text NOT NULL,
  material_encrypted text NOT NULL,
  expires_at timestamptz,
  refresh_failed_at timestamptz,
  -- A worker refreshing this OAuth login holds the refresh until then (no row
  -- lock or connection is held during the token request).
  refresh_lease_until timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  CONSTRAINT end_user_tool_credentials_subject_server_uq
    UNIQUE (account_id, workspace_id, end_user_subject_id, tool_server_id),
  CONSTRAINT end_user_tool_credentials_server_fk FOREIGN KEY (tool_server_id, account_id)
    REFERENCES organization_tool_servers(id, account_id) ON DELETE CASCADE,
  CONSTRAINT end_user_tool_credentials_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT end_user_tool_credentials_bounds_check CHECK (
    end_user_subject_id LIKE 'external_user:%' AND char_length(end_user_subject_id) <= 512
    AND kind IN ('headers', 'oauth')
    AND octet_length(material_encrypted) BETWEEN 1 AND 131072
    AND version > 0
  )
);
CREATE INDEX end_user_tool_credentials_server_idx ON end_user_tool_credentials (tool_server_id);
COMMENT ON TABLE end_user_tool_credentials IS 'One end user''s login for an organization tool server in a managed workspace. Encrypted by the application; never readable through the API.';

-- Where an organization agent is available ---------------------------------

CREATE TABLE agent_workspace_access (
  agent_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  enabled_by_subject_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, workspace_id),
  CONSTRAINT agent_workspace_access_agent_fk FOREIGN KEY (agent_id, account_id)
    REFERENCES agents(id, account_id) ON DELETE CASCADE,
  CONSTRAINT agent_workspace_access_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT agent_workspace_access_bounds_check CHECK (
    enabled_by_subject_id IS NULL OR char_length(enabled_by_subject_id) BETWEEN 1 AND 1024
  )
);
CREATE INDEX agent_workspace_access_workspace_idx ON agent_workspace_access (workspace_id);
COMMENT ON TABLE agent_workspace_access IS 'Workspaces an organization agent is available in besides the organization''s managed workspaces.';

-- Publishes ---------------------------------------------------------------

CREATE TABLE agent_publish_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  from_revision integer,
  to_revision integer NOT NULL,
  move_running_chats boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending',
  moved_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  -- Why a move never ran: move_unavailable, move_start_failed or superseded.
  failure_reason text,
  created_by_subject_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT agent_publish_operations_agent_fk FOREIGN KEY (agent_id, account_id)
    REFERENCES agents(id, account_id) ON DELETE CASCADE,
  CONSTRAINT agent_publish_operations_bounds_check CHECK (
    (from_revision IS NULL OR from_revision > 0)
    AND to_revision > 0
    AND status IN ('pending', 'running', 'succeeded', 'failed')
    AND moved_count >= 0 AND failed_count >= 0
    AND (failure_reason IS NULL OR char_length(failure_reason) BETWEEN 1 AND 64)
    AND (created_by_subject_id IS NULL OR char_length(created_by_subject_id) BETWEEN 1 AND 1024)
  )
);
CREATE INDEX agent_publish_operations_agent_idx
  ON agent_publish_operations (agent_id, created_at DESC);
COMMENT ON TABLE agent_publish_operations IS 'Each publish or rollback of an organization agent, and the chats it moved.';

ALTER TABLE organization_tool_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_tool_servers FORCE ROW LEVEL SECURITY;
ALTER TABLE end_user_tool_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE end_user_tool_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_workspace_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_workspace_access FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_publish_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_publish_operations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE organization_tool_servers FROM PUBLIC;
REVOKE ALL ON TABLE end_user_tool_credentials FROM PUBLIC;
REVOKE ALL ON TABLE agent_workspace_access FROM PUBLIC;
REVOKE ALL ON TABLE agent_publish_operations FROM PUBLIC;

-- The organization: the account context and each of its workspaces (a chat's
-- turn reads the servers its agent uses).
CREATE POLICY account_isolation ON organization_tool_servers
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));
-- A workspace context reads its own rows; the account context reads every row
-- of the organization (deleting logins across workspaces).
CREATE POLICY account_isolation ON end_user_tool_credentials
  USING (opengeni_private.optional_workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.optional_workspace_rls_visible(account_id, workspace_id));
-- The account reads every row; a workspace reads its own.
CREATE POLICY account_isolation ON agent_workspace_access
  USING (opengeni_private.optional_workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.optional_workspace_rls_visible(account_id, workspace_id));
CREATE POLICY account_isolation ON agent_publish_operations
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));

DO $organization_agents_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    -- Exact grants, whatever the owner's default privileges gave the runtime.
    REVOKE ALL ON organization_tool_servers, end_user_tool_credentials,
      agent_workspace_access, agent_publish_operations FROM opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON organization_tool_servers TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON end_user_tool_credentials TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_workspace_access TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE ON agent_publish_operations TO opengeni_app;
  END IF;
END
$organization_agents_grants$;

-- Chats ------------------------------------------------------------------

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS agent_version integer,
  ADD COLUMN IF NOT EXISTS agent_prompt_version integer,
  ADD COLUMN IF NOT EXISTS agent_overrides jsonb;
ALTER TABLE sessions ADD CONSTRAINT sessions_agent_version_check CHECK (
  (agent_version IS NULL OR (agent_version > 0 AND agent_id IS NOT NULL AND agent_prompt_revision IS NULL))
  AND (agent_prompt_version IS NULL OR (agent_prompt_version > 0 AND agent_version IS NOT NULL))
  AND (agent_overrides IS NULL OR (
    agent_version IS NOT NULL AND jsonb_typeof(agent_overrides) = 'object'
    AND pg_column_size(agent_overrides) <= 262144))
) NOT VALID;
COMMENT ON COLUMN sessions.agent_version IS 'The organization agent version this chat runs (agents.id = agent_id); NULL for every other chat.';
COMMENT ON COLUMN sessions.agent_prompt_version IS 'The organization agent version whose Instructions are in this chat''s system prompt.';
COMMENT ON COLUMN sessions.agent_overrides IS 'What this chat changed from its organization agent version: {setting: {agent, chat}}. NULL when nothing.';

-- A worker without organization agent support would run such a chat without
-- its agent's Instructions and tools: refuse its claim (as 1276 does).
CREATE OR REPLACE FUNCTION guard_org_agent_claim_protocol() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE
  prior_subject text := coalesce(current_setting('opengeni.subject_id', true), '');
  prior_account text := coalesce(current_setting('opengeni.account_id', true), '');
  prior_workspace text := coalesce(current_setting('opengeni.workspace_id', true), '');
  pinned_version integer;
BEGIN
  IF current_setting('opengeni.org_agent_protocol_v1', true) = '1' THEN
    RETURN NEW;
  END IF;
  PERFORM set_config('opengeni.subject_id', '', true);
  PERFORM set_config('opengeni.account_id', NEW.account_id::text, true);
  PERFORM set_config('opengeni.workspace_id', NEW.workspace_id::text, true);
  SELECT s.agent_version INTO pinned_version
  FROM sessions s
  WHERE s.workspace_id = NEW.workspace_id AND s.id = NEW.session_id;
  PERFORM set_config('opengeni.subject_id', prior_subject, true);
  PERFORM set_config('opengeni.account_id', prior_account, true);
  PERFORM set_config('opengeni.workspace_id', prior_workspace, true);
  IF pinned_version IS NOT NULL THEN
    RAISE EXCEPTION 'session requires organization agent protocol v1' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_org_agent_claim_protocol() FROM PUBLIC;

DROP TRIGGER IF EXISTS org_agent_claim_protocol_guard ON session_turn_attempts;
CREATE TRIGGER org_agent_claim_protocol_guard
  BEFORE INSERT ON session_turn_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_org_agent_claim_protocol();

-- Console --------------------------------------------------------------------

ALTER TABLE organization_managed_workspaces
  DROP CONSTRAINT organization_managed_workspaces_source_check;
ALTER TABLE organization_managed_workspaces
  ADD CONSTRAINT organization_managed_workspaces_source_check
  CHECK (source IN ('api_key', 'backfill', 'console', 'console_test')) NOT VALID;

ALTER TABLE organization_console_audit_events
  DROP CONSTRAINT organization_console_audit_events_action_check;
ALTER TABLE organization_console_audit_events
  ADD CONSTRAINT organization_console_audit_events_action_check
  CHECK (action IN ('session.transcript_viewed', 'session.metadata_viewed',
    'settings.review_level_changed', 'workspace.kind_changed',
    'agent.created', 'agent.updated', 'agent.version_saved', 'agent.published',
    'agent.archived', 'agent.management_changed', 'agent.deployed',
    'tool_server.created', 'tool_server.updated', 'tool_server.deleted',
    'tool_credential.written', 'tool_credential.deleted',
    'member.console_role_changed', 'member.console_test_access_granted',
    'member.console_test_access_removed')) NOT VALID;
