-- deployment-mode: rolling
-- online-safety-exception: table-rewrite: SET NOT NULL on agent_slack_installs.install_workspace_id does not scan, because 1321 validated CHECK (install_workspace_id IS NOT NULL) and PostgreSQL uses it as the proof.
-- contract-step: since the agents contract (migrations 1301 to 1319) every binary writes agent_slack_installs.install_workspace_id, so no running binary inserts a row without it.
-- Agents legacy drop: install_workspace_id becomes NOT NULL and 1320's
-- check, now redundant, goes.
SET LOCAL lock_timeout = '5s';

ALTER TABLE agent_slack_installs ALTER COLUMN install_workspace_id SET NOT NULL;
ALTER TABLE agent_slack_installs DROP CONSTRAINT agent_slack_installs_install_workspace_check;
