-- deployment-mode: rolling
-- contract-step: since the agents contract (migrations 1301 to 1319) no binary names slack_agent_intro_posts_agent_channel_uq in ON CONFLICT; it writes against 1319's per-installation unique index.
-- Agents legacy drop: drop the per-agent unique key from before an agent
-- could be in several Slack installations, so the same shared channel (Slack
-- Connect) in two installations of one agent gets a record in each. One
-- table per file.
SET LOCAL lock_timeout = '5s';

ALTER TABLE slack_agent_intro_posts DROP CONSTRAINT IF EXISTS slack_agent_intro_posts_agent_channel_uq;
