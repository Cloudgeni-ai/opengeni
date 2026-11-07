-- deployment-mode: rolling
-- Agents contract: validate the foreign keys 1302 and 1304 to 1309 added NOT
-- VALID. Validation takes SHARE UPDATE EXCLUSIVE on each referencing table and
-- ROW SHARE on the referenced one, so reads and writes continue while it
-- scans.
--
-- Every referencing table carries the installation's connection_id, and every
-- slack_agents row has had its agent_slack_installs row since 1243 (backfill,
-- sync trigger, then the API's dual write), so existing rows satisfy the keys.
SET LOCAL lock_timeout = '5s';

ALTER TABLE agent_slack_installs VALIDATE CONSTRAINT agent_slack_installs_install_workspace_fk;
ALTER TABLE slack_channel_routes VALIDATE CONSTRAINT slack_channel_routes_agent_install_fk;
ALTER TABLE slack_interactions VALIDATE CONSTRAINT slack_interactions_agent_install_fk;
ALTER TABLE slack_agent_user_states VALIDATE CONSTRAINT slack_agent_user_states_agent_install_fk;
ALTER TABLE slack_agent_proposals VALIDATE CONSTRAINT slack_agent_proposals_created_agent_install_fk;
ALTER TABLE slack_agent_intro_posts VALIDATE CONSTRAINT slack_agent_intro_posts_agent_install_fk;
ALTER TABLE slack_agent_suggestions VALIDATE CONSTRAINT slack_agent_suggestions_agent_install_fk;
