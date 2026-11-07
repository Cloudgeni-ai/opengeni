-- deployment-mode: rolling
-- online-safety-exception: explicit-lock: dropping this key takes ACCESS EXCLUSIVE on connections and slack_agents anyway; locking connections first matches the order a cascading connection delete (a Slack disconnect) takes them in, so the drop cannot deadlock with one.
-- contract-step: since the agents contract (migrations 1301 to 1319) no binary reads slack_agents or inserts into it (the contract only deletes an agent's leftover row, without touching the referenced tables), so its foreign keys protect nothing.
-- Agents legacy drop: drop slack_agents's foreign key to connections before
-- the table (1328). Lock order as in 1325. A workspace delete reaches both
-- tables through its own cascades, in an order PostgreSQL does not fix; if it
-- runs into this file's short lock wait, PostgreSQL aborts one side and the
-- file is safe to rerun.
SET LOCAL lock_timeout = '5s';

LOCK TABLE connections IN ACCESS EXCLUSIVE MODE;
LOCK TABLE slack_agents IN ACCESS EXCLUSIVE MODE;
ALTER TABLE slack_agents DROP CONSTRAINT IF EXISTS slack_agents_connection_id_fkey;
