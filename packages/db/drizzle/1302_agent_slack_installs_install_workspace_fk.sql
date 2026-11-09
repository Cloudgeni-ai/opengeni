-- deployment-mode: rolling
-- Agents contract: deleting the Slack installation's workspace deletes its
-- agent_slack_installs rows, as it deleted the slack_agents rows. Added NOT
-- VALID; 1310 validates it.
--
-- Rolling: a NOT VALID key checks only new writes. It is alone in this file so
-- the SHARE ROW EXCLUSIVE locks it takes on agent_slack_installs and
-- workspaces end with it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE agent_slack_installs
  ADD CONSTRAINT agent_slack_installs_install_workspace_fk
  FOREIGN KEY (install_workspace_id, account_id)
  REFERENCES workspaces(id, account_id) ON DELETE CASCADE NOT VALID;
