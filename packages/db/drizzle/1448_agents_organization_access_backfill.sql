-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: sets agents.organization_access on the shared agents that are in Slack (a handful per organization) to the value the previous release reads from their installations' open, once.
-- Agents contract step for Anyone in the organization (docs/agents.md, "Who
-- can use it"): agents.organization_access becomes the only source. Until
-- now, while an agent was in Slack, it was open to its organization only if
-- every agent_slack_installs row was open (AGENT_ORGANIZATION_ACCESS_SQL in
-- the previous release); the column decided only for an agent in no Slack
-- installation. This copies that effective value onto the column, so this
-- release, which reads only the column, sees what the previous release saw.
-- An Only me agent is never open.
--
-- Rolling: the previous release writes the column and every installation's
-- open together on every change, so they stay equal after this runs; this
-- release keeps writing open too, for it. agents and agent_slack_installs are
-- FORCE ROW LEVEL SECURITY, so the window is lifted for the backfill and
-- restored before commit (docs/force-rls-migration-backfills.md); the ACCESS
-- EXCLUSIVE locks hold both tables' readers and writers until commit. agents
-- is locked first, as its writers lock the agent's row first. A NOTICE
-- reports the count.
SET LOCAL lock_timeout = '5s';

ALTER TABLE agents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_slack_installs NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  changed bigint;
BEGIN
  UPDATE agents a SET organization_access = (
      a.visibility = 'workspace'
      AND NOT EXISTS (
        SELECT 1 FROM agent_slack_installs i
        WHERE i.agent_id = a.id AND i.account_id = a.account_id AND NOT i.open
      )
    )
  WHERE EXISTS (
      SELECT 1 FROM agent_slack_installs i
      WHERE i.agent_id = a.id AND i.account_id = a.account_id
    )
    AND a.organization_access IS DISTINCT FROM (
      a.visibility = 'workspace'
      AND NOT EXISTS (
        SELECT 1 FROM agent_slack_installs i
        WHERE i.agent_id = a.id AND i.account_id = a.account_id AND NOT i.open
      )
    );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RAISE NOTICE 'agents organization access backfill: agents changed %', changed;
END $$;

ALTER TABLE agent_slack_installs FORCE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
