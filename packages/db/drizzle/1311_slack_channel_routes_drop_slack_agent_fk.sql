-- deployment-mode: rolling
-- contract-step: since #7274 (with #7000, #7156 and #7281) every binary writes agent_slack_installs itself, so no running binary needs slack_channel_routes's foreign key to slack_agents; slack_channel_routes_agent_install_fk (validated in 1310) replaces it.
-- Agents contract: drop slack_channel_routes's foreign key to slack_agents.
--
-- One key per file: dropping it locks slack_channel_routes and then slack_agents, the
-- order writers of the previous release take them in.
SET LOCAL lock_timeout = '5s';

ALTER TABLE slack_channel_routes DROP CONSTRAINT IF EXISTS slack_channel_routes_slack_agent_fk;
