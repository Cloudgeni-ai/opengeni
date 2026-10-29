-- deployment-mode: rolling
-- A Teams 1:1 chat from a linked person can land in their own Personal
-- workspace, as a Slack bot DM already does. The route stays in the
-- installation's workspace (its inbox, outbox, link and lease are that
-- installation's), and session_workspace_id names the workspace its session
-- lives in. Only a 1:1 route can name one: channels and group chats stay in the
-- installation's workspace. The API derives it from the linked person's active
-- organization membership pointer, never from a Teams payload.
--   1. session_workspace_id must be a workspace of the same organization; the
--      route goes with it if that workspace is deleted.
--   2. The route row is visible in that session workspace's scope too, so the
--      native session event wake and the admission proof can find it there.
--      Nothing else in the Personal workspace's scope reads Teams rows, and
--      only its owner works there.
--   3. The native session event wake matches the route by its session's
--      workspace.
-- Existing routes have no session_workspace_id and keep their workspace. A
-- previous binary never writes the column. If a previous pump drains a new
-- Personal route during rollout, it can start that one chat as Only me in the
-- installation's workspace for the same person; the new binary then refuses
-- that route's outputs with the usual audience notice and nothing is shared.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE teams_bot_routes ADD COLUMN session_workspace_id uuid;
ALTER TABLE teams_bot_routes ADD CONSTRAINT teams_bot_routes_session_workspace_fkey
  FOREIGN KEY (session_workspace_id, account_id) REFERENCES workspaces(id, account_id)
  ON DELETE CASCADE;
ALTER TABLE teams_bot_routes ADD CONSTRAINT teams_bot_routes_session_workspace_check
  CHECK (session_workspace_id IS NULL OR
    (personal AND channel_id IS NULL AND group_audience IS NULL
      AND session_workspace_id <> workspace_id));
CREATE INDEX teams_bot_routes_session_workspace
  ON teams_bot_routes USING btree (session_workspace_id, session_id)
  WHERE session_workspace_id IS NOT NULL;

DROP POLICY workspace_isolation ON teams_bot_routes;
CREATE POLICY workspace_isolation ON teams_bot_routes
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)
    OR (session_workspace_id IS NOT NULL
      AND opengeni_private.workspace_rls_visible(account_id, session_workspace_id)))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id)
    OR (session_workspace_id IS NOT NULL
      AND opengeni_private.workspace_rls_visible(account_id, session_workspace_id)));

DO $teams_personal_workspace_wake$
DECLARE definition text; anchor text;
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.wake_teams_route_for_session_event()'::regprocedure);
  anchor := $a$ WHERE account_id=NEW.account_id AND workspace_id=NEW.workspace_id AND session_id=NEW.session_id;$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'wake_teams_route_for_session_event anchor drifted';
  END IF;
  EXECUTE replace(definition, anchor,
    $r$ WHERE account_id=NEW.account_id AND (workspace_id=NEW.workspace_id OR session_workspace_id=NEW.workspace_id) AND session_id=NEW.session_id;$r$);
END
$teams_personal_workspace_wake$;
