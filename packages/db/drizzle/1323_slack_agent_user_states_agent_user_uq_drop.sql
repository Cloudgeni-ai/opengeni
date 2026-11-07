-- deployment-mode: rolling
-- contract-step: since the agents contract (migrations 1301 to 1319) no binary names slack_agent_user_states_agent_user_uq in ON CONFLICT; it writes against 1318's per-installation unique index.
-- Agents legacy drop: drop the per-agent unique key from before an agent
-- could be in several Slack installations, so the same Slack person
-- (Enterprise Grid) in two installations of one agent gets a record in each.
-- One table per file.
SET LOCAL lock_timeout = '5s';

ALTER TABLE slack_agent_user_states DROP CONSTRAINT IF EXISTS slack_agent_user_states_agent_user_uq;
