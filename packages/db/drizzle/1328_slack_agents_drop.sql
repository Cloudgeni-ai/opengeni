-- deployment-mode: rolling
-- contract-step: since the agents contract (migrations 1301 to 1319) no binary reads slack_agents or inserts into it, nothing references it (1311 to 1316 dropped those keys), and its readiness check accepts the table absent. The contract's delete of an agent's leftover row waits on this file's lock and skips once the table is gone.
-- Agents legacy drop: drop the legacy Slack agents table (agents and
-- agent_slack_installs replaced it) and 1301's fill trigger on it. 1325 to
-- 1327 dropped its own foreign keys, so this locks only slack_agents; if any
-- foreign key is still there (a constraint name that differs), it stops
-- rather than lock every table that key involves. No CASCADE: its policies
-- and indexes go with it.
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  leftover text;
BEGIN
  IF to_regclass('slack_agents') IS NOT NULL THEN
    SELECT string_agg(conname, ', ' ORDER BY conname) INTO leftover
    FROM pg_catalog.pg_constraint
    WHERE contype = 'f'
      AND (conrelid = to_regclass('slack_agents') OR confrelid = to_regclass('slack_agents'));
    IF leftover IS NOT NULL THEN
      RAISE EXCEPTION 'slack_agents still has a foreign key (%); drop it before 1328', leftover;
    END IF;
  END IF;
END $$;

DROP TRIGGER IF EXISTS slack_agents_fill_agent_install_workspace ON slack_agents;
DROP TABLE IF EXISTS slack_agents;
