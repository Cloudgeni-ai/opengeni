-- deployment-mode: rolling
-- online-safety-exception: explicit-lock: dropping these keys takes ACCESS EXCLUSIVE on managed_accounts and slack_agents anyway; locking managed_accounts first matches the order a cascading account delete takes them in, so the drop cannot deadlock with one.
-- contract-step: since the agents contract (migrations 1301 to 1319) no binary reads slack_agents or inserts into it (the contract only deletes an agent's leftover row, without touching the referenced tables), so its foreign keys protect nothing.
-- Agents legacy drop: drop slack_agents's foreign keys to managed_accounts
-- before the table (1328), one referenced table per file.
--
-- Lock order: the referenced table, then slack_agents, as a cascading delete
-- of the referenced row takes them. Taking slack_agents first deadlocked with
-- such a delete in review.
SET LOCAL lock_timeout = '5s';

LOCK TABLE managed_accounts IN ACCESS EXCLUSIVE MODE;
LOCK TABLE slack_agents IN ACCESS EXCLUSIVE MODE;
ALTER TABLE slack_agents DROP CONSTRAINT IF EXISTS slack_agents_account_id_fkey;
ALTER TABLE slack_agents DROP CONSTRAINT IF EXISTS slack_agents_target_account_id_fkey;
