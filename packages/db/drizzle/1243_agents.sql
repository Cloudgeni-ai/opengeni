-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: copies bot_templates (at most a few hundred per workspace) and slack_agents (days old, a handful per Slack installation) once into the new agents tables.
-- Agents (docs/agents.md): one channel-independent record that replaces
-- Slack agents and bot templates. This is the expand step; nothing reads the
-- new tables yet, so behaviour is unchanged.
--
-- - agents: the directory row, owned by the HOME workspace (where the
--   agent's chats run). Everyone in the organization may read rows that are
--   not Only me (private); an Only me row is visible only to its owner.
-- - agent_revisions: immutable Instructions and First message. Never
--   organization readable, and the runtime may only read and insert.
-- - agent_slack_installs: where an agent is available in Slack, owned by the
--   agent's HOME workspace so a rename updates it in the same transaction.
--
-- Every id is kept: agents.id = slack_agents.id = bot_templates.id.
--
-- Until the contract step, triggers mirror legacy writes (older binaries
-- still write bot_templates and slack_agents) into the new tables. They are
-- a no-op while opengeni.agents_dual_write = '1', which new code sets when it
-- writes both shapes itself. They run as the writer (SECURITY INVOKER) and
-- switch the tenancy settings to the agent's home workspace with no person,
-- like guard_explicit_workspace_recovery_warning, then restore them. Every
-- update they make must change exactly one row or they raise.
--
-- The legacy checks are widened (NOT VALID here; 1244 validates them) so
-- that new code writing both shapes never fails on the old, smaller limits.
--
-- Rolling: the previous release never reads the new tables. Its writes to
-- bot_templates and slack_agents keep succeeding: the new tables' checks
-- accept every value the legacy checks accept, and the triggers never reject
-- a legacy write except for an id that belongs to another workspace's agent
-- (random uuids never collide in practice). An all-blank template name, which
-- bot_templates allows, becomes 'Bot template' on the agent. The new tables
-- are FORCE RLS with ordinary runtime grants, which the previous release's readiness
-- accepts for unknown tables; the trigger functions are SECURITY INVOKER.
SET LOCAL lock_timeout = '5s';

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  visibility text NOT NULL,
  owner_subject_id text,
  name text NOT NULL,
  name_key text NOT NULL,
  description text NOT NULL DEFAULT '',
  avatar jsonb,
  memory_enabled boolean NOT NULL DEFAULT false,
  memory_collection_id uuid,
  current_revision integer NOT NULL DEFAULT 1,
  origin text NOT NULL,
  source_session_id uuid,
  created_by_subject_id text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agents_id_account_uq UNIQUE (id, account_id),
  CONSTRAINT agents_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT agents_visibility_check CHECK (visibility IN ('private', 'workspace')),
  CONSTRAINT agents_private_owner_check
    CHECK (visibility = 'workspace' OR owner_subject_id IS NOT NULL),
  CONSTRAINT agents_origin_check
    CHECK (origin IN ('slack_agent', 'bot_template', 'app', 'slack')),
  -- Bounds accept every value either legacy table accepts (after widening):
  -- the avatar bound is the union of bot_templates' and slack_agents'.
  CONSTRAINT agents_bounds_check CHECK (
    char_length(btrim(name)) BETWEEN 1 AND 120
    AND char_length(name_key) BETWEEN 1 AND 120
    AND char_length(description) <= 280
    AND (avatar IS NULL OR (
      jsonb_typeof(avatar) = 'object'
      AND (pg_column_size(avatar) <= 4096 OR octet_length(avatar::text) <= 1024)
    ))
    AND (owner_subject_id IS NULL OR char_length(owner_subject_id) BETWEEN 1 AND 1024)
    AND (created_by_subject_id IS NULL OR char_length(created_by_subject_id) BETWEEN 1 AND 1024)
    AND current_revision > 0
    AND version > 0
  )
);
CREATE INDEX agents_workspace_idx ON agents (workspace_id, created_at);
CREATE INDEX agents_account_idx ON agents (account_id);
COMMENT ON TABLE agents IS 'Agents: one record per agent, owned by its home workspace (where its chats run). Instructions and First message live in agent_revisions.';
COMMENT ON COLUMN agents.name_key IS 'lower(btrim(name)), for name clash hints only; deliberately not unique.';

CREATE TABLE agent_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  revision integer NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  first_message text NOT NULL DEFAULT '',
  created_by_subject_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_revisions_agent_revision_uq UNIQUE (agent_id, revision),
  CONSTRAINT agent_revisions_agent_fk FOREIGN KEY (agent_id, account_id)
    REFERENCES agents(id, account_id) ON DELETE CASCADE,
  CONSTRAINT agent_revisions_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT agent_revisions_bounds_check CHECK (
    revision > 0
    AND char_length(btrim(name)) BETWEEN 1 AND 120
    AND char_length(description) <= 280
    AND char_length(instructions) <= 20000
    AND char_length(first_message) <= 20000
    AND (created_by_subject_id IS NULL OR char_length(created_by_subject_id) BETWEEN 1 AND 1024)
  )
);
CREATE INDEX agent_revisions_workspace_idx ON agent_revisions (workspace_id);
COMMENT ON TABLE agent_revisions IS 'Immutable agent content (Instructions, First message, name and description as of the revision). Home workspace only; the runtime may only read and insert.';

CREATE TABLE agent_slack_installs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  slack_team_id text NOT NULL,
  name_key text NOT NULL,
  open boolean NOT NULL DEFAULT false,
  enabled_by_subject_id text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_slack_installs_agent_connection_uq UNIQUE (agent_id, connection_id),
  CONSTRAINT agent_slack_installs_name_key_uq UNIQUE (connection_id, name_key),
  CONSTRAINT agent_slack_installs_agent_fk FOREIGN KEY (agent_id, account_id)
    REFERENCES agents(id, account_id) ON DELETE CASCADE,
  CONSTRAINT agent_slack_installs_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT agent_slack_installs_bounds_check CHECK (
    octet_length(slack_team_id) BETWEEN 1 AND 64
    AND name_key ~ '^[^[:space:]-]{1,80}$'
    AND (enabled_by_subject_id IS NULL OR char_length(enabled_by_subject_id) BETWEEN 1 AND 1024)
    AND version > 0
  )
);
CREATE INDEX agent_slack_installs_workspace_idx ON agent_slack_installs (workspace_id);
COMMENT ON TABLE agent_slack_installs IS 'Where an agent is available in Slack: one row per agent and Slack installation, owned by the agent''s home workspace. name_key is the Slack handle key.';

-- RLS is enabled now and forced after the backfill below, which runs as the
-- table owner.
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_slack_installs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE agents FROM PUBLIC;
REVOKE ALL ON TABLE agent_revisions FROM PUBLIC;
REVOKE ALL ON TABLE agent_slack_installs FROM PUBLIC;

CREATE POLICY workspace_isolation ON agents
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
-- The organization directory: every agent that is not Only me. Read only.
CREATE POLICY agents_organization_read ON agents
  FOR SELECT
  USING (account_id = opengeni_private.current_account_id() AND visibility <> 'private');
-- Only me agents, like channels_visibility_isolation (1161): a context
-- without a person (system work) sees every row; otherwise a private row is
-- visible only to its owner (the acting person, or the person an agent turn
-- acts for, while an active member) in its home workspace.
CREATE POLICY agents_private_isolation ON agents AS RESTRICTIVE
  USING (
    nullif(current_setting('opengeni.subject_id', true), '') IS NULL
    OR visibility = 'workspace'
    OR (
      workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
      AND account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
      AND owner_subject_id = ANY (ARRAY(
        SELECT substr(actor_key, strpos(actor_key, ':') + 1)
        FROM unnest((SELECT session_private_actor_visible_keys())) AS actor_key
      ))
    )
  )
  WITH CHECK (
    nullif(current_setting('opengeni.subject_id', true), '') IS NULL
    OR visibility = 'workspace'
    OR (
      workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
      AND account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
      AND owner_subject_id = ANY (ARRAY(
        SELECT substr(actor_key, strpos(actor_key, ':') + 1)
        FROM unnest((SELECT session_private_actor_visible_keys())) AS actor_key
      ))
    )
  );

-- Revisions: the home workspace only, and only while the caller can see the
-- agent itself, so the Only me rule carries over.
CREATE POLICY workspace_isolation ON agent_revisions
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY agent_revisions_agent_visible ON agent_revisions AS RESTRICTIVE
  USING (EXISTS (SELECT 1 FROM agents a WHERE a.id = agent_revisions.agent_id))
  WITH CHECK (EXISTS (SELECT 1 FROM agents a WHERE a.id = agent_revisions.agent_id));

-- Slack availability: written from the agent's home workspace; Slack
-- routing reads it from the installation's home workspace. Read only.
CREATE POLICY workspace_isolation ON agent_slack_installs
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY agent_slack_installs_organization_read ON agent_slack_installs
  FOR SELECT
  USING (account_id = opengeni_private.current_account_id());
-- An installation row is visible only with its agent, so an Only me agent's
-- Slack availability carries its privacy.
CREATE POLICY agent_slack_installs_agent_visible ON agent_slack_installs
  AS RESTRICTIVE
  USING (EXISTS (SELECT 1 FROM agents a WHERE a.id = agent_slack_installs.agent_id))
  WITH CHECK (EXISTS (SELECT 1 FROM agents a WHERE a.id = agent_slack_installs.agent_id));

DO $agents_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    -- Exact grants: the schema's default privileges may already have given
    -- the runtime role full DML on these new tables, and revisions are
    -- read-and-insert only.
    REVOKE ALL ON agents, agent_revisions, agent_slack_installs FROM opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agents TO opengeni_app;
    GRANT SELECT, INSERT ON agent_revisions TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_slack_installs TO opengeni_app;
  END IF;
END
$agents_grants$;

-- Mirror an older binary's bot template writes. A template owns the
-- directory fields and the First message; Instructions are carried over from
-- the agent's current revision. A template never changes an agent that came
-- from a Slack agent (an id collision keeps the Slack agent).
CREATE FUNCTION sync_agent_from_bot_template() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE
  prior_subject text := coalesce(current_setting('opengeni.subject_id', true), '');
  prior_account text := coalesce(current_setting('opengeni.account_id', true), '');
  prior_workspace text := coalesce(current_setting('opengeni.workspace_id', true), '');
  actor text := nullif(prior_subject, '');
  template_id uuid;
  template_name text;
  existing_origin text;
  existing_revision integer;
  existing_instructions text;
  existing_first_message text;
  next_revision integer;
  changed integer;
BEGIN
  IF current_setting('opengeni.agents_dual_write', true) = '1' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    template_id := OLD.id;
    PERFORM set_config('opengeni.account_id', OLD.account_id::text, true);
    PERFORM set_config('opengeni.workspace_id', OLD.workspace_id::text, true);
  ELSE
    template_id := NEW.id;
    -- bot_templates does not trim before its length check; an all-blank
    -- name gets a placeholder rather than failing the legacy write.
    template_name := coalesce(nullif(btrim(NEW.name), ''), 'Bot template');
    PERFORM set_config('opengeni.account_id', NEW.account_id::text, true);
    PERFORM set_config('opengeni.workspace_id', NEW.workspace_id::text, true);
  END IF;
  PERFORM set_config('opengeni.subject_id', '', true);

  SELECT a.origin, a.current_revision INTO existing_origin, existing_revision
  FROM agents a WHERE a.id = template_id FOR UPDATE;

  IF existing_origin = 'slack_agent' THEN
    RAISE NOTICE 'bot template % shares its id with a Slack agent; the agent keeps the Slack agent', template_id;
  ELSIF TG_OP = 'DELETE' THEN
    -- Absent already when a workspace deletion cascaded to both rows.
    DELETE FROM agents WHERE id = template_id;
  ELSIF existing_origin IS NULL THEN
    INSERT INTO agents (id, account_id, workspace_id, visibility, owner_subject_id, name,
      name_key, description, avatar, memory_enabled, current_revision, origin,
      source_session_id, created_by_subject_id, created_at, updated_at)
    VALUES (NEW.id, NEW.account_id, NEW.workspace_id, NEW.visibility,
      CASE WHEN NEW.visibility = 'private' THEN NEW.created_by_subject_id END,
      template_name, lower(template_name), btrim(NEW.description), NEW.avatar, false, 1,
      'bot_template', NEW.source_session_id, NEW.created_by_subject_id,
      NEW.created_at, NEW.updated_at);
    INSERT INTO agent_revisions (agent_id, account_id, workspace_id, revision, name,
      description, instructions, first_message, created_by_subject_id)
    VALUES (NEW.id, NEW.account_id, NEW.workspace_id, 1, template_name,
      btrim(NEW.description), '', NEW.setup_instructions,
      coalesce(actor, NEW.created_by_subject_id));
  ELSE
    -- Only what this write changed, so fields the agent gained elsewhere stay.
    UPDATE agents a SET
      name = CASE WHEN TG_OP = 'INSERT' OR NEW.name IS DISTINCT FROM OLD.name
        THEN template_name ELSE a.name END,
      name_key = CASE WHEN TG_OP = 'INSERT' OR NEW.name IS DISTINCT FROM OLD.name
        THEN lower(template_name) ELSE a.name_key END,
      description = CASE WHEN TG_OP = 'INSERT' OR NEW.description IS DISTINCT FROM OLD.description
        THEN btrim(NEW.description) ELSE a.description END,
      avatar = CASE WHEN TG_OP = 'INSERT' OR NEW.avatar IS DISTINCT FROM OLD.avatar
        THEN NEW.avatar ELSE a.avatar END,
      visibility = CASE WHEN TG_OP = 'INSERT' OR NEW.visibility IS DISTINCT FROM OLD.visibility
          OR NEW.created_by_subject_id IS DISTINCT FROM OLD.created_by_subject_id
        THEN NEW.visibility ELSE a.visibility END,
      owner_subject_id = CASE WHEN TG_OP = 'INSERT' OR NEW.visibility IS DISTINCT FROM OLD.visibility
          OR NEW.created_by_subject_id IS DISTINCT FROM OLD.created_by_subject_id
        THEN CASE WHEN NEW.visibility = 'private' THEN NEW.created_by_subject_id END
        ELSE a.owner_subject_id END,
      source_session_id = CASE
        WHEN TG_OP = 'INSERT' OR NEW.source_session_id IS DISTINCT FROM OLD.source_session_id
        THEN NEW.source_session_id ELSE a.source_session_id END,
      version = a.version + 1,
      updated_at = now()
    WHERE a.id = template_id;
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 1 THEN
      RAISE EXCEPTION 'agent % sync from bot template changed % rows', template_id, changed
        USING ERRCODE = '55000';
    END IF;
    SELECT r.instructions, r.first_message INTO existing_instructions, existing_first_message
    FROM agent_revisions r WHERE r.agent_id = template_id AND r.revision = existing_revision;
    IF existing_first_message IS DISTINCT FROM NEW.setup_instructions THEN
      SELECT coalesce(max(r.revision), 0) + 1 INTO next_revision
      FROM agent_revisions r WHERE r.agent_id = template_id;
      INSERT INTO agent_revisions (agent_id, account_id, workspace_id, revision, name,
        description, instructions, first_message, created_by_subject_id)
      SELECT a.id, a.account_id, a.workspace_id, next_revision, a.name, a.description,
        coalesce(existing_instructions, ''), NEW.setup_instructions,
        coalesce(actor, NEW.created_by_subject_id)
      FROM agents a WHERE a.id = template_id;
      UPDATE agents SET current_revision = next_revision WHERE id = template_id;
      GET DIAGNOSTICS changed = ROW_COUNT;
      IF changed <> 1 THEN
        RAISE EXCEPTION 'agent % revision sync from bot template changed % rows', template_id, changed
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;

  PERFORM set_config('opengeni.subject_id', prior_subject, true);
  PERFORM set_config('opengeni.account_id', prior_account, true);
  PERFORM set_config('opengeni.workspace_id', prior_workspace, true);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION sync_agent_from_bot_template() FROM PUBLIC;

-- Mirror an older binary's Slack agent writes. A Slack agent owns the
-- directory fields, Memory, its Instructions and its Slack installation row;
-- the First message is carried over from the agent's current revision. The
-- agent lives in the Slack agent's TARGET workspace, which is the agent's
-- home, while the legacy row belongs to the installation's workspace.
-- Deleting a Slack agent deletes the agent.
CREATE FUNCTION sync_agent_from_slack_agent() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE
  prior_subject text := coalesce(current_setting('opengeni.subject_id', true), '');
  prior_account text := coalesce(current_setting('opengeni.account_id', true), '');
  prior_workspace text := coalesce(current_setting('opengeni.workspace_id', true), '');
  actor text := nullif(prior_subject, '');
  existing_origin text;
  existing_revision integer;
  existing_instructions text;
  existing_first_message text;
  next_revision integer;
  changed integer;
BEGIN
  IF current_setting('opengeni.agents_dual_write', true) = '1' THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('opengeni.subject_id', '', true);
  IF TG_OP = 'DELETE' THEN
    PERFORM set_config('opengeni.account_id', OLD.target_account_id::text, true);
    PERFORM set_config('opengeni.workspace_id', OLD.target_workspace_id::text, true);
    -- Absent already when a workspace deletion cascaded to both rows.
    DELETE FROM agents WHERE id = OLD.id;
  ELSE
    PERFORM set_config('opengeni.account_id', NEW.target_account_id::text, true);
    PERFORM set_config('opengeni.workspace_id', NEW.target_workspace_id::text, true);
    SELECT a.origin, a.current_revision INTO existing_origin, existing_revision
    FROM agents a WHERE a.id = NEW.id FOR UPDATE;

    IF existing_origin IS NULL THEN
      INSERT INTO agents (id, account_id, workspace_id, visibility, owner_subject_id, name,
        name_key, description, avatar, memory_enabled, memory_collection_id, current_revision,
        origin, created_by_subject_id, created_at, updated_at)
      VALUES (NEW.id, NEW.target_account_id, NEW.target_workspace_id, 'workspace', NULL,
        btrim(NEW.name), lower(btrim(NEW.name)), btrim(NEW.description), NEW.avatar, true,
        NEW.knowledge_collection_id, 1, 'slack_agent', NEW.created_by_subject_id,
        NEW.created_at, NEW.updated_at);
      INSERT INTO agent_revisions (agent_id, account_id, workspace_id, revision, name,
        description, instructions, first_message, created_by_subject_id)
      VALUES (NEW.id, NEW.target_account_id, NEW.target_workspace_id, 1, btrim(NEW.name),
        btrim(NEW.description), NEW.instructions, '', coalesce(actor, NEW.created_by_subject_id));
    ELSE
      -- Only what this write changed, so fields the agent gained elsewhere
      -- stay. A new Slack agent that shares a template's id takes the agent.
      UPDATE agents a SET
        name = CASE WHEN TG_OP = 'INSERT' OR NEW.name IS DISTINCT FROM OLD.name
          THEN btrim(NEW.name) ELSE a.name END,
        name_key = CASE WHEN TG_OP = 'INSERT' OR NEW.name IS DISTINCT FROM OLD.name
          THEN lower(btrim(NEW.name)) ELSE a.name_key END,
        description = CASE WHEN TG_OP = 'INSERT' OR NEW.description IS DISTINCT FROM OLD.description
          THEN btrim(NEW.description) ELSE a.description END,
        avatar = CASE WHEN TG_OP = 'INSERT' OR NEW.avatar IS DISTINCT FROM OLD.avatar
          THEN NEW.avatar ELSE a.avatar END,
        visibility = CASE WHEN TG_OP = 'INSERT' THEN 'workspace' ELSE a.visibility END,
        owner_subject_id = CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE a.owner_subject_id END,
        memory_enabled = CASE WHEN TG_OP = 'INSERT' THEN true ELSE a.memory_enabled END,
        memory_collection_id = CASE
          WHEN TG_OP = 'INSERT' OR NEW.knowledge_collection_id IS DISTINCT FROM OLD.knowledge_collection_id
          THEN NEW.knowledge_collection_id ELSE a.memory_collection_id END,
        origin = CASE WHEN TG_OP = 'INSERT' AND a.origin = 'bot_template'
          THEN 'slack_agent' ELSE a.origin END,
        version = a.version + 1,
        updated_at = now()
      WHERE a.id = NEW.id;
      GET DIAGNOSTICS changed = ROW_COUNT;
      IF changed <> 1 THEN
        RAISE EXCEPTION 'agent % sync from Slack agent changed % rows', NEW.id, changed
          USING ERRCODE = '55000';
      END IF;
      SELECT r.instructions, r.first_message INTO existing_instructions, existing_first_message
      FROM agent_revisions r WHERE r.agent_id = NEW.id AND r.revision = existing_revision;
      IF existing_instructions IS DISTINCT FROM NEW.instructions THEN
        SELECT coalesce(max(r.revision), 0) + 1 INTO next_revision
        FROM agent_revisions r WHERE r.agent_id = NEW.id;
        INSERT INTO agent_revisions (agent_id, account_id, workspace_id, revision, name,
          description, instructions, first_message, created_by_subject_id)
        SELECT a.id, a.account_id, a.workspace_id, next_revision, a.name, a.description,
          NEW.instructions, coalesce(existing_first_message, ''),
          coalesce(actor, NEW.created_by_subject_id)
        FROM agents a WHERE a.id = NEW.id;
        UPDATE agents SET current_revision = next_revision WHERE id = NEW.id;
        GET DIAGNOSTICS changed = ROW_COUNT;
        IF changed <> 1 THEN
          RAISE EXCEPTION 'agent % revision sync from Slack agent changed % rows', NEW.id, changed
            USING ERRCODE = '55000';
        END IF;
      END IF;
    END IF;

    INSERT INTO agent_slack_installs AS i (agent_id, account_id, workspace_id, connection_id,
      slack_team_id, name_key, open, enabled_by_subject_id)
    VALUES (NEW.id, NEW.target_account_id, NEW.target_workspace_id, NEW.connection_id,
      NEW.slack_team_id, NEW.name_key, NEW.open, coalesce(actor, NEW.created_by_subject_id))
    ON CONFLICT (agent_id, connection_id) DO UPDATE SET
      slack_team_id = EXCLUDED.slack_team_id,
      name_key = EXCLUDED.name_key,
      open = EXCLUDED.open,
      version = i.version + 1,
      updated_at = now();
    -- A Slack agent never moves to another installation; if one did, its old
    -- installation row goes with it.
    IF TG_OP = 'UPDATE' AND NEW.connection_id IS DISTINCT FROM OLD.connection_id THEN
      DELETE FROM agent_slack_installs WHERE agent_id = NEW.id AND connection_id = OLD.connection_id;
    END IF;
  END IF;

  PERFORM set_config('opengeni.subject_id', prior_subject, true);
  PERFORM set_config('opengeni.account_id', prior_account, true);
  PERFORM set_config('opengeni.workspace_id', prior_workspace, true);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION sync_agent_from_slack_agent() FROM PUBLIC;

-- Wider legacy checks, so new code writing both shapes never fails on the old
-- limits: Slack agent names up to 120, descriptions 0..280 and Instructions
-- up to 20,000 characters; template setup text 0..20,000 (an empty First
-- message). The name_key rule is unchanged. Each new check accepts every row
-- the old one did; 1244 validates them.
-- This comes before CREATE TRIGGER so the legacy tables' first lock is
-- ACCESS EXCLUSIVE: SHARE ROW EXCLUSIVE first, then an upgrade, could
-- deadlock with a writer that read a table before inserting into it.
ALTER TABLE slack_agents DROP CONSTRAINT slack_agents_bounds_check;
ALTER TABLE slack_agents ADD CONSTRAINT slack_agents_bounds_check CHECK (
  octet_length(slack_team_id) BETWEEN 1 AND 64
  AND char_length(btrim(name)) BETWEEN 1 AND 120
  AND name_key ~ '^[^[:space:]-]{1,80}$'
  AND char_length(btrim(description)) <= 280
  AND jsonb_typeof(avatar) = 'object'
  AND pg_column_size(avatar) <= 4096
  AND char_length(instructions) <= 20000
  AND octet_length(created_by_subject_id) BETWEEN 1 AND 1024
  AND version > 0
) NOT VALID;
ALTER TABLE bot_templates DROP CONSTRAINT bot_templates_setup_instructions_check;
ALTER TABLE bot_templates ADD CONSTRAINT bot_templates_setup_instructions_check
  CHECK (char_length(setup_instructions) <= 20000) NOT VALID;

CREATE TRIGGER bot_templates_sync_agent
  AFTER INSERT OR UPDATE OR DELETE ON bot_templates
  FOR EACH ROW EXECUTE FUNCTION sync_agent_from_bot_template();
CREATE TRIGGER slack_agents_sync_agent
  AFTER INSERT OR UPDATE OR DELETE ON slack_agents
  FOR EACH ROW EXECUTE FUNCTION sync_agent_from_slack_agent();

-- Backfill. bot_templates and slack_agents are FORCE RLS and the migration
-- owner has no tenancy settings, so their FORCE RLS is lifted for the backfill
-- and restored before commit (docs/force-rls-migration-backfills.md). The
-- table locks taken above already exclude every concurrent writer, so the
-- triggers created above cannot miss a write made during this migration.
ALTER TABLE slack_agents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE bot_templates NO FORCE ROW LEVEL SECURITY;

-- Slack agents: same id, home = the Slack agent's target workspace, shared
-- with the workspace, Memory on with its collection, Instructions in
-- revision 1, and one Slack installation row.
INSERT INTO agents (id, account_id, workspace_id, visibility, owner_subject_id, name, name_key,
  description, avatar, memory_enabled, memory_collection_id, current_revision, origin,
  created_by_subject_id, created_at, updated_at)
SELECT s.id, s.target_account_id, s.target_workspace_id, 'workspace', NULL, btrim(s.name),
  lower(btrim(s.name)), btrim(s.description), s.avatar, true, s.knowledge_collection_id, 1,
  'slack_agent', s.created_by_subject_id, s.created_at, s.updated_at
FROM slack_agents s
ON CONFLICT (id) DO NOTHING;

INSERT INTO agent_revisions (agent_id, account_id, workspace_id, revision, name, description,
  instructions, first_message, created_by_subject_id, created_at)
SELECT s.id, s.target_account_id, s.target_workspace_id, 1, btrim(s.name), btrim(s.description),
  s.instructions, '', s.created_by_subject_id, s.updated_at
FROM slack_agents s
JOIN agents a ON a.id = s.id AND a.origin = 'slack_agent'
ON CONFLICT (agent_id, revision) DO NOTHING;

INSERT INTO agent_slack_installs (agent_id, account_id, workspace_id, connection_id,
  slack_team_id, name_key, open, enabled_by_subject_id, created_at, updated_at)
SELECT s.id, s.target_account_id, s.target_workspace_id, s.connection_id, s.slack_team_id,
  s.name_key, s.open, s.created_by_subject_id, s.created_at, s.updated_at
FROM slack_agents s
JOIN agents a ON a.id = s.id AND a.origin = 'slack_agent'
ON CONFLICT (agent_id, connection_id) DO NOTHING;

-- Bot templates: same id and workspace, visibility kept (an Only me
-- template's owner is whoever saved it), Memory off, the template text
-- becomes the First message and Instructions stay empty. Chats started from
-- a template are not linked to the agent. A template sharing a Slack agent's
-- id is skipped; the agent keeps the Slack agent.
DO $agents_template_collisions$
DECLARE
  colliding uuid;
BEGIN
  FOR colliding IN
    SELECT t.id FROM bot_templates t JOIN slack_agents s ON s.id = t.id ORDER BY t.id
  LOOP
    RAISE NOTICE 'bot template % shares its id with a Slack agent; the agent keeps the Slack agent', colliding;
  END LOOP;
END
$agents_template_collisions$;

INSERT INTO agents (id, account_id, workspace_id, visibility, owner_subject_id, name, name_key,
  description, avatar, memory_enabled, current_revision, origin, source_session_id,
  created_by_subject_id, created_at, updated_at)
SELECT t.id, t.account_id, t.workspace_id, t.visibility,
  CASE WHEN t.visibility = 'private' THEN t.created_by_subject_id END,
  coalesce(nullif(btrim(t.name), ''), 'Bot template'),
  lower(coalesce(nullif(btrim(t.name), ''), 'Bot template')), btrim(t.description), t.avatar,
  false, 1, 'bot_template', t.source_session_id, t.created_by_subject_id, t.created_at,
  t.updated_at
FROM bot_templates t
WHERE NOT EXISTS (SELECT 1 FROM slack_agents s WHERE s.id = t.id)
ON CONFLICT (id) DO NOTHING;

INSERT INTO agent_revisions (agent_id, account_id, workspace_id, revision, name, description,
  instructions, first_message, created_by_subject_id, created_at)
SELECT t.id, t.account_id, t.workspace_id, 1, coalesce(nullif(btrim(t.name), ''), 'Bot template'),
  btrim(t.description), '', t.setup_instructions, t.created_by_subject_id, t.updated_at
FROM bot_templates t
JOIN agents a ON a.id = t.id AND a.origin = 'bot_template'
ON CONFLICT (agent_id, revision) DO NOTHING;

ALTER TABLE bot_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_agents FORCE ROW LEVEL SECURITY;

ALTER TABLE agents FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_slack_installs FORCE ROW LEVEL SECURITY;
