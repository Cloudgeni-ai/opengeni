-- deployment-mode: rolling
-- connector_action_requests.agent_rule names the agent and Can use rule that
-- made a call ask or blocked it (docs/agents.md). Nullable with no default,
-- so adding it rewrites no rows; the previous release never reads or sets it
-- and keeps recording such calls with policy_source 'default', as this
-- release still does.
SET LOCAL lock_timeout = '5s';
ALTER TABLE connector_action_requests ADD COLUMN IF NOT EXISTS agent_rule jsonb;
