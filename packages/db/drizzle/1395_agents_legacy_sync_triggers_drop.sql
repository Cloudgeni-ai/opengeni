-- deployment-mode: rolling
-- contract-step: since #7274 (with #7000, #7156 and #7281) every binary writes agents, revisions and agent_slack_installs itself and turns the sync triggers off while it writes legacy rows, so they never fire for a running binary.
-- Agents contract: drop 1243's legacy sync triggers. Their functions stay
-- until the legacy drop, because the previous release's readiness check
-- requires them to exist.
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS bot_templates_sync_agent ON bot_templates;
DROP TRIGGER IF EXISTS slack_agents_sync_agent ON slack_agents;
