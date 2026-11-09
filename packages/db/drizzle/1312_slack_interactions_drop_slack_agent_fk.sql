-- deployment-mode: rolling
-- contract-step: since #7274 (with #7000, #7156 and #7281) every binary writes agent_slack_installs itself, so no running binary needs slack_interactions's foreign key to slack_agents; slack_interactions_agent_install_fk (validated in 1310) replaces it.
-- Agents contract: drop slack_interactions's foreign key to slack_agents.
--
-- One key per file: dropping it locks slack_interactions and then slack_agents, the
-- order writers of the previous release take them in.
SET LOCAL lock_timeout = '5s';

ALTER TABLE slack_interactions DROP CONSTRAINT IF EXISTS slack_interactions_slack_agent_fk;
