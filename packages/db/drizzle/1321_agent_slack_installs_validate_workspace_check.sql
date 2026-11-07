-- deployment-mode: rolling
-- Agents legacy drop: validate 1320's check. VALIDATE takes SHARE UPDATE
-- EXCLUSIVE, so reads and writes continue while it scans.
SET LOCAL lock_timeout = '5s';

ALTER TABLE agent_slack_installs VALIDATE CONSTRAINT agent_slack_installs_install_workspace_check;
