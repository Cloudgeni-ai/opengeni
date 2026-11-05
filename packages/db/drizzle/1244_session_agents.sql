-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: links only chats started for a Slack agent (slack_interactions with a slack_agent_id, found through slack_interactions_slack_agent_idx), a small set: Slack agents shipped days before this migration.
-- Which agent a chat belongs to (docs/agents.md):
--
-- - sessions.agent_id: the agent the chat was started for. No foreign key
--   (sessions is large; readers recheck the agent on use, like the inbox
--   columns). It may only be set once, from NULL; a guard refuses any other
--   change. Forks copy it with the row; child workers never set it. It is
--   unrelated to agent_config and agent_access, which configure the runtime.
-- - sessions.agent_prompt_revision: the agent revision whose Instructions are
--   in the chat's system prompt. NULL is a legacy chat whose instructions are
--   already in sessions.instructions, so the agent layer is never added.
--
-- Existing Slack agent chats are linked to their agent from
-- slack_interactions.slack_agent_id (the interaction the chat started with),
-- keeping agent_prompt_revision NULL. The check on the new columns stays NOT
-- VALID: every existing row is NULL, and validating would only scan sessions
-- under this file's locks; it is enforced for every new or changed row.
--
-- Also validates the legacy checks 1243 widened.
--
-- Rolling: the previous release neither names nor reads the new columns; its
-- inserts leave them NULL, its updates never set agent_id, and forks copy the
-- whole row as before. The migration owner is NOSUPERUSER NOBYPASSRLS, so
-- FORCE RLS is lifted for the backfill and restored before commit (as in
-- 1229). Those ALTER TABLE locks exclude every other reader and writer until
-- commit, so no workspace tenancy fence is taken; the fence-checking trigger
-- is disabled for the migration's own write and enabled again before commit.
SET LOCAL lock_timeout = '5s';

ALTER TABLE slack_agents VALIDATE CONSTRAINT slack_agents_bounds_check;
ALTER TABLE bot_templates VALIDATE CONSTRAINT bot_templates_setup_instructions_check;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_prompt_revision integer;
ALTER TABLE sessions ADD CONSTRAINT sessions_agent_prompt_revision_check CHECK (
  agent_prompt_revision IS NULL OR (agent_prompt_revision > 0 AND agent_id IS NOT NULL)
) NOT VALID;
COMMENT ON COLUMN sessions.agent_id IS 'The agent (agents.id) this chat was started for; set once, never changed. Not agent_config or agent_access.';
COMMENT ON COLUMN sessions.agent_prompt_revision IS 'The agent revision in this chat''s system prompt; NULL for chats whose instructions are in sessions.instructions.';

CREATE FUNCTION guard_session_agent_id_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
BEGIN
  IF OLD.agent_id IS NOT NULL AND NEW.agent_id IS DISTINCT FROM OLD.agent_id THEN
    RAISE EXCEPTION 'a chat''s agent cannot change' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_session_agent_id_immutable() FROM PUBLIC;
CREATE TRIGGER sessions_agent_id_immutable
  BEFORE UPDATE OF agent_id ON sessions
  FOR EACH ROW EXECUTE FUNCTION guard_session_agent_id_immutable();

ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_interactions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE agents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions DISABLE TRIGGER session_tenancy_workspace_fence;
UPDATE sessions s
SET agent_id = started.agent_id
FROM (
  SELECT DISTINCT ON (i.session_id) i.session_id, i.slack_agent_id AS agent_id
  FROM slack_interactions i
  WHERE i.slack_agent_id IS NOT NULL AND i.session_id IS NOT NULL
  ORDER BY i.session_id, i.created_at, i.id
) started
JOIN agents a ON a.id = started.agent_id
WHERE s.id = started.session_id
  AND s.workspace_id = a.workspace_id
  AND s.agent_id IS NULL;
ALTER TABLE sessions ENABLE TRIGGER session_tenancy_workspace_fence;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_interactions FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
