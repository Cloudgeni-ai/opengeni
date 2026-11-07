-- deployment-mode: rolling
-- contract-step: since #7274 (with #7000, #7156 and #7281) every binary writes agent_slack_installs itself, so no running binary needs slack_agent_intro_posts's foreign key to slack_agents; slack_agent_intro_posts_agent_install_fk (validated in 1310) replaces it.
-- Agents contract: drop slack_agent_intro_posts's foreign key to slack_agents.
--
-- One key per file: dropping it locks slack_agent_intro_posts and then slack_agents, the
-- order writers of the previous release take them in.
SET LOCAL lock_timeout = '5s';

ALTER TABLE slack_agent_intro_posts DROP CONSTRAINT IF EXISTS slack_agent_intro_posts_slack_agent_id_fkey;
