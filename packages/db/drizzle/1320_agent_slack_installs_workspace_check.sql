-- deployment-mode: rolling
-- contract-step: since the agents contract (migrations 1301 to 1319) every binary writes agent_slack_installs.install_workspace_id, so no running binary inserts a row without it.
-- Agents legacy drop (docs/agents.md, "Legacy drop"): a NOT VALID check that
-- every agent_slack_installs row has its installation's workspace; 1321
-- validates it and 1322 makes the column NOT NULL.
--
-- No backfill: 1301 copied the workspace onto every existing row, its fill
-- trigger covered the API switch's writes during the contract rollout, and
-- the contract writes it itself. If a row still lacks it, 1321 fails and the
-- release stops before anything is dropped (docs/agents.md has the check to
-- run first). A copy from slack_agents would have to lift FORCE RLS on both
-- tables, holding two tables that cascading deletes reach in either order.
-- Locks only agent_slack_installs.
SET LOCAL lock_timeout = '5s';

ALTER TABLE agent_slack_installs
  ADD CONSTRAINT agent_slack_installs_install_workspace_check
  CHECK (install_workspace_id IS NOT NULL) NOT VALID;
