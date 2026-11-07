-- deployment-mode: rolling
-- contract-step: since the agents contract (migrations 1301 to 1319) no binary calls these functions and its readiness check accepts them absent; their triggers went with 1317 and 1328.
-- Agents legacy drop: drop the trigger functions bound to the legacy tables:
-- 1243's sync functions and 1301's installation workspace fill.
SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS fill_agent_slack_install_workspace();
DROP FUNCTION IF EXISTS sync_agent_from_slack_agent();
DROP FUNCTION IF EXISTS sync_agent_from_bot_template();
