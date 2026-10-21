-- deployment-mode: rolling
-- A workspace administrator connects and removes their workspace's own
-- subscription accounts (SUB-OWN-09), without organization administration.
--
-- "The workspace's own account" is one exact shape: a shared connection
-- whose scope is chosen workspaces, that the workspace manages, that never
-- reaches Personal workspaces and that serves no other workspace. The
-- organization still owns it (SUB-OWN-01): its administrators see it in the
-- organization's accounts, and only they widen its scope, change its
-- manager or take it over (the 0642 scope guard is unchanged).
--
-- 1. INSERT: an organization administrator, as before, or an administrator
--    of the workspace the connection is managed by, for exactly that shape.
-- 2. The workspace link of such a connection: its manager may add the row
--    for its own workspace. 0645's helper is the existing "this workspace
--    manages that connection" authority (organization administrator, or an
--    administrator of the managing workspace), as the assignment-policy
--    rows already use it.
-- 3. Disconnect: the managing workspace's administrator may remove the
--    workspace's own account; every other shared connection stays
--    organization-administrator only.
--    The routine runs as the table owner under FORCE RLS, so it reads the
--    connection's workspace links of every workspace only through an
--    owner-run policy bound to the exact connection's `connection_owner`
--    capability, which it already holds.
-- Policies and one routine body only: no table rewrite or long lock.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE POLICY subscription_connections_insert_workspace_admin ON subscription_connections
  FOR INSERT
  WITH CHECK (
    account_id::text = nullif(current_setting('opengeni.account_id', true), '')
    AND ownership = 'shared'
    AND scope_kind = 'workspaces'
    AND allow_personal_workspaces = false
    AND owner_organization_membership_id IS NULL
    AND owner_subject_id IS NULL
    AND managed_by_workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM workspace_memberships grant_row
      WHERE grant_row.account_id = subscription_connections.account_id
        AND grant_row.workspace_id = subscription_connections.managed_by_workspace_id
        AND grant_row.subject_id = nullif(current_setting('opengeni.subject_id', true), '')
        AND grant_row.role = 'admin'));

CREATE POLICY subscription_connection_workspaces_workspace_admin ON subscription_connection_workspaces
  FOR INSERT
  WITH CHECK (
    account_id::text = nullif(current_setting('opengeni.account_id', true), '')
    AND workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    AND opengeni_private.subscription_apps_designation_manage_allowed(
      account_id, workspace_id, connection_id));

CREATE POLICY subscription_core_owner_connection_workspaces_read ON subscription_connection_workspaces
  FOR SELECT
  USING (current_user = pg_catalog.pg_get_userbyid((SELECT relation.relowner
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'subscription_connection_workspaces'::regclass))
    AND opengeni_private.subscription_core_owner_capability_held(
      NULL, account_id, ARRAY['connection_owner'], NULL, connection_id, false));

DO $workspace_disconnect$
DECLARE
  definition text;
  anchor constant text := $a$      IF target.ownership = 'shared' THEN
        IF NOT opengeni_private.subscription_organization_admin(p_account_id) THEN$a$;
  replacement constant text := $r$      IF target.ownership = 'shared' THEN
        -- An organization administrator removes any shared connection; the
        -- managing workspace's administrator only the workspace's own
        -- account (migration 0777).
        IF NOT opengeni_private.subscription_organization_admin(p_account_id)
          AND NOT (target.scope_kind = 'workspaces'
            AND NOT target.allow_personal_workspaces
            AND p_workspace_id IS NOT NULL
            AND target.managed_by_workspace_id = p_workspace_id
            AND EXISTS (SELECT 1 FROM workspace_memberships manager
              WHERE manager.account_id = p_account_id AND manager.workspace_id = p_workspace_id
                AND manager.subject_id = p_subject_id AND manager.role = 'admin')
            AND NOT EXISTS (SELECT 1 FROM subscription_connection_workspaces assignment
              WHERE assignment.account_id = p_account_id
                AND assignment.connection_id = p_connection_id
                AND assignment.workspace_id <> p_workspace_id))
        THEN$r$;
BEGIN
  definition := pg_catalog.pg_get_functiondef(
    'opengeni_private.disconnect_subscription_core_connection(text, uuid, uuid, text, uuid)'::regprocedure);
  IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
    RAISE EXCEPTION 'subscription core disconnect source changed';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$workspace_disconnect$;
