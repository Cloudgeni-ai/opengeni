-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: fills install_workspace_id on the agent_slack_installs rows still missing it (an older release's rows with no legacy row to copy from; none are expected, since the contract release fills them when it places agents), from their Slack connection's workspace.
-- contract-step: since the agents contract (migrations 1380 to 1399) every binary writes agent_slack_installs.install_workspace_id, so no running binary inserts a row without it.
-- Agents legacy drop (docs/agents.md, "Legacy drop"): every agent_slack_installs
-- row gets its installation's workspace, then a NOT VALID check requires it;
-- 1408 validates it and 1409 makes the column NOT NULL.
--
-- Repair, so validation can't fail: a row still missing it gets its Slack
-- connection's workspace (the installation's own workspace, which is what
-- the API writes). A row whose connection has no workspace is removed, as
-- turning Slack off there would; the API places a shared agent again in
-- every linked Slack workspace. A NOTICE reports both counts.
--
-- Rolling: agent_slack_installs is FORCE ROW LEVEL SECURITY, so the window is
-- lifted for the repair and restored before commit
-- (docs/force-rls-migration-backfills.md); its ACCESS EXCLUSIVE lock holds the
-- table's readers and writers until commit. connections is lifted the same
-- way only when a row needs repair, so the usual release takes no lock on it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE agent_slack_installs NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  missing bigint;
  repaired bigint := 0;
  removed bigint := 0;
BEGIN
  SELECT count(*) INTO missing FROM agent_slack_installs WHERE install_workspace_id IS NULL;
  IF missing > 0 THEN
    EXECUTE 'ALTER TABLE connections NO FORCE ROW LEVEL SECURITY';
    UPDATE agent_slack_installs i SET install_workspace_id = c.workspace_id
    FROM connections c
    WHERE c.id = i.connection_id
      AND c.account_id = i.account_id
      AND c.workspace_id IS NOT NULL
      AND i.install_workspace_id IS NULL;
    GET DIAGNOSTICS repaired = ROW_COUNT;
    EXECUTE 'ALTER TABLE connections FORCE ROW LEVEL SECURITY';
    DELETE FROM agent_slack_installs WHERE install_workspace_id IS NULL;
    GET DIAGNOSTICS removed = ROW_COUNT;
  END IF;
  RAISE NOTICE 'agents legacy drop: agent_slack_installs install_workspace_id filled %, removed %',
    repaired, removed;
END $$;

ALTER TABLE agent_slack_installs FORCE ROW LEVEL SECURITY;

ALTER TABLE agent_slack_installs
  ADD CONSTRAINT agent_slack_installs_install_workspace_check
  CHECK (install_workspace_id IS NOT NULL) NOT VALID;
