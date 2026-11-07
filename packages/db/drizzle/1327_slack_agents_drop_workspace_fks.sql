-- deployment-mode: rolling
-- online-safety-exception: explicit-lock: dropping these keys takes ACCESS EXCLUSIVE on workspaces and slack_agents anyway; locking workspaces first matches the order a cascading workspace delete takes them in, so the drop cannot deadlock with one.
-- contract-step: since the agents contract (migrations 1301 to 1319) no binary reads slack_agents or inserts into it (the contract only deletes an agent's leftover row, without touching the referenced tables), so its foreign keys protect nothing.
-- Agents legacy drop: drop slack_agents's four foreign keys to workspaces
-- before the table (1328). Lock order as in 1325. 1325 and 1326 removed the
-- account and connection keys, so a cascade now reaches slack_agents only
-- through workspaces, which this file locks first.
SET LOCAL lock_timeout = '5s';

LOCK TABLE workspaces IN ACCESS EXCLUSIVE MODE;
LOCK TABLE slack_agents IN ACCESS EXCLUSIVE MODE;
ALTER TABLE slack_agents DROP CONSTRAINT IF EXISTS slack_agents_workspace_id_fkey;
ALTER TABLE slack_agents DROP CONSTRAINT IF EXISTS slack_agents_target_workspace_id_fkey;
ALTER TABLE slack_agents DROP CONSTRAINT IF EXISTS slack_agents_workspace_account_fk;
ALTER TABLE slack_agents DROP CONSTRAINT IF EXISTS slack_agents_target_workspace_account_fk;
