-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: copies one workspace id per Slack agent (a handful per Slack installation) from slack_agents into agent_slack_installs once, and raises the version of the agents whose legacy row had a higher one (the same handful of rows).
-- Agents contract (docs/agents.md, "Contract"): the Slack
-- installation's own workspace moves onto agent_slack_installs, so nothing
-- reads slack_agents any more.
--
-- * agent_slack_installs.install_workspace_id: the installation binding's
--   workspace (where its routes, user states and intro records live). It was
--   only on the legacy slack_agents row (slack_agents.workspace_id). 1302 adds
--   its foreign key to workspaces.
-- * The backfill copies it from slack_agents, and raises each agent's version
--   to its legacy row's where that is higher, so the legacy Slack agents API
--   (which showed the greater of the two during the rollout) never goes back.
-- * fill_agent_slack_install_workspace: older binaries (#7274)
--   still insert agent_slack_installs without the column and then their
--   slack_agents row. This trigger copies the workspace from that row, so
--   their writes during the rollout are complete too. It is dropped with
--   slack_agents in the legacy drop.
--
-- Rolling: a new nullable column the previous release never reads and a
-- SECURITY INVOKER trigger function. The backfill lifts FORCE ROW LEVEL
-- SECURITY on three small tables and restores it before commit
-- (docs/force-rls-migration-backfills.md); those ACCESS EXCLUSIVE locks hold
-- every reader and writer of the three tables until commit. agents is locked
-- first because every writer locks its agents row first. A single statement
-- that reads agent_slack_installs before agents (the Slack directory join)
-- could still deadlock with it; PostgreSQL then aborts one side, and the
-- migration is safe to run again.
SET LOCAL lock_timeout = '5s';

ALTER TABLE agents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_agents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_slack_installs NO FORCE ROW LEVEL SECURITY;

ALTER TABLE agent_slack_installs ADD COLUMN IF NOT EXISTS install_workspace_id uuid;
COMMENT ON COLUMN agent_slack_installs.install_workspace_id IS 'The Slack installation''s own workspace (its binding''s), where its routes and Slack records live.';

CREATE FUNCTION fill_agent_slack_install_workspace() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE
  prior_subject text := coalesce(current_setting('opengeni.subject_id', true), '');
  prior_account text := coalesce(current_setting('opengeni.account_id', true), '');
  prior_workspace text := coalesce(current_setting('opengeni.workspace_id', true), '');
BEGIN
  -- The installation row belongs to the agent's home (the Slack agent's
  -- target workspace), not to the writer's installation workspace.
  PERFORM set_config('opengeni.subject_id', '', true);
  PERFORM set_config('opengeni.account_id', NEW.target_account_id::text, true);
  PERFORM set_config('opengeni.workspace_id', NEW.target_workspace_id::text, true);
  UPDATE agent_slack_installs SET install_workspace_id = NEW.workspace_id
  WHERE agent_id = NEW.id
    AND connection_id = NEW.connection_id
    AND install_workspace_id IS DISTINCT FROM NEW.workspace_id;
  PERFORM set_config('opengeni.subject_id', prior_subject, true);
  PERFORM set_config('opengeni.account_id', prior_account, true);
  PERFORM set_config('opengeni.workspace_id', prior_workspace, true);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION fill_agent_slack_install_workspace() FROM PUBLIC;

CREATE TRIGGER slack_agents_fill_agent_install_workspace
  AFTER INSERT OR UPDATE OF workspace_id, connection_id ON slack_agents
  FOR EACH ROW EXECUTE FUNCTION fill_agent_slack_install_workspace();

UPDATE agent_slack_installs i SET install_workspace_id = s.workspace_id
FROM slack_agents s
WHERE s.id = i.agent_id
  AND s.connection_id = i.connection_id
  AND i.install_workspace_id IS NULL;

UPDATE agents a SET version = s.version
FROM slack_agents s
WHERE s.id = a.id AND s.version > a.version;

ALTER TABLE agent_slack_installs FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_agents FORCE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
