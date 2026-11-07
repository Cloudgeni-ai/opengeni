-- deployment-mode: rolling
-- Agents contract (docs/agents.md, "Contract"): slack_agent_suggestions.slack_agent_id also
-- references the agent's installation row, agent_slack_installs (agent_id,
-- connection_id), ON DELETE CASCADE. Added NOT VALID; 1310 validates it and
-- 1316 drops the old key to slack_agents.
--
-- A slack_agents row was one agent in one Slack installation, so its exact
-- equivalent is the agent's agent_slack_installs row for that connection:
-- turning Slack off in one installation still deletes that installation's
-- suggestions, while the agent and its other installations stay.
--
-- Rolling: a NOT VALID key checks only new writes, and every binary since
-- #7274 writes the installation row before anything that names the
-- agent in that installation. One key per file: adding it locks slack_agent_suggestions
-- and then agent_slack_installs, the order writers take them in.
SET LOCAL lock_timeout = '5s';

ALTER TABLE slack_agent_suggestions
  ADD CONSTRAINT slack_agent_suggestions_agent_install_fk
  FOREIGN KEY (slack_agent_id, connection_id)
  REFERENCES agent_slack_installs(agent_id, connection_id)
  ON DELETE CASCADE NOT VALID;
