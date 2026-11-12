-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: removes or unlinks Slack records whose agent has no installation row for their connection, and installation rows whose workspace is gone. Production had none on 2026-11-05, so these statements touch a handful of rows at most.
-- Agents contract: before 1390 validates the foreign keys 1381 and 1383 to
-- 1388 added NOT VALID, clean up the rows that would fail them, the way each
-- key's ON DELETE action would have, so validation can't fail and Slack
-- history people can see is kept:
--
-- * agent_slack_installs whose installation workspace (install_workspace_id,
--   account_id) is gone: deleted, as ON DELETE CASCADE would have. That
--   workspace held the installation's routes, chats and other Slack records,
--   so nothing visible is lost; if the Slack workspace is still linked, the
--   API places the shared agent there again with the right workspace.
--   Deleting them first lets the keys below cascade or unlink their records.
-- * slack_interactions.slack_agent_id and
--   slack_agent_proposals.created_slack_agent_id naming an agent with no
--   installation row for the record's connection_id: set to null (ON DELETE
--   SET NULL), so the chat and the proposal stay.
-- * slack_channel_routes, slack_agent_user_states, slack_agent_intro_posts
--   and slack_agent_suggestions rows like that: deleted (ON DELETE CASCADE).
--
-- A NOTICE reports the count per table.
--
-- Rolling: the NOT VALID keys already refuse new orphans from every running
-- binary, so nothing written after this file commits can fail 1390. The
-- seven tables are FORCE ROW LEVEL SECURITY and the migration principal is
-- their owner, so the window is lifted for the cleanup and restored before
-- commit (docs/force-rls-migration-backfills.md); its ACCESS EXCLUSIVE locks
-- hold every reader and writer of these tables until commit. The Slack record
-- tables are locked before agent_slack_installs, the order their writers
-- take them in. workspaces has no row level security.
SET LOCAL lock_timeout = '5s';

ALTER TABLE slack_channel_routes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_interactions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_agent_user_states NO FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_agent_proposals NO FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_agent_intro_posts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_agent_suggestions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_slack_installs NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  removed bigint;
BEGIN
  DELETE FROM agent_slack_installs i
  WHERE i.install_workspace_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM workspaces w
      WHERE w.id = i.install_workspace_id AND w.account_id = i.account_id
    );
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE 'agents contract orphans: agent_slack_installs deleted %', removed;

  UPDATE slack_interactions r SET slack_agent_id = NULL
  WHERE r.slack_agent_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM agent_slack_installs i
      WHERE i.agent_id = r.slack_agent_id AND i.connection_id = r.connection_id
    );
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE 'agents contract orphans: slack_interactions unlinked %', removed;

  UPDATE slack_agent_proposals r SET created_slack_agent_id = NULL
  WHERE r.created_slack_agent_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM agent_slack_installs i
      WHERE i.agent_id = r.created_slack_agent_id AND i.connection_id = r.connection_id
    );
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE 'agents contract orphans: slack_agent_proposals unlinked %', removed;

  DELETE FROM slack_channel_routes r
  WHERE r.slack_agent_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM agent_slack_installs i
      WHERE i.agent_id = r.slack_agent_id AND i.connection_id = r.connection_id
    );
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE 'agents contract orphans: slack_channel_routes deleted %', removed;

  DELETE FROM slack_agent_user_states r
  WHERE NOT EXISTS (
    SELECT 1 FROM agent_slack_installs i
    WHERE i.agent_id = r.slack_agent_id AND i.connection_id = r.connection_id
  );
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE 'agents contract orphans: slack_agent_user_states deleted %', removed;

  DELETE FROM slack_agent_intro_posts r
  WHERE NOT EXISTS (
    SELECT 1 FROM agent_slack_installs i
    WHERE i.agent_id = r.slack_agent_id AND i.connection_id = r.connection_id
  );
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE 'agents contract orphans: slack_agent_intro_posts deleted %', removed;

  DELETE FROM slack_agent_suggestions r
  WHERE NOT EXISTS (
    SELECT 1 FROM agent_slack_installs i
    WHERE i.agent_id = r.slack_agent_id AND i.connection_id = r.connection_id
  );
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE 'agents contract orphans: slack_agent_suggestions deleted %', removed;
END $$;

ALTER TABLE agent_slack_installs FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_agent_suggestions FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_agent_intro_posts FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_agent_proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_agent_user_states FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_interactions FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_channel_routes FORCE ROW LEVEL SECURITY;
