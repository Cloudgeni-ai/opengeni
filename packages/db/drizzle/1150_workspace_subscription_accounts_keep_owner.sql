-- deployment-mode: rolling
-- A workspace's own subscription connection keeps its owner when it serves
-- more workspaces (docs/subscription-accounts.md D-52, superseding the last
-- clause of D-50). Until now a connection with managed_by_workspace_id could
-- be assigned only to that workspace, so the access editor cleared the owner
-- whenever an organization administrator shared it more widely and the
-- workspace's administrators silently lost it.
--
-- 1. The owner-reach triggers from migration 0907, which refused any
--    assignment of a workspace's own connection outside that workspace, are
--    dropped. Personal workspaces stay out because every writer keeps them
--    out: the organization editor accepts only the organization's shared
--    workspaces, and the workspace policies below need an administrator
--    membership in the added workspace, which a Personal workspace never has.
--    subscription_connections_workspace_owner_reach_chk still keeps such a
--    connection to chosen workspaces, without Personal workspaces. The
--    trigger function stays (unused) so the runtime posture inventory and
--    the previous release are unaffected; a later release can drop it.
-- 2. Row policies for the managing workspace: its context reads where its
--    connection serves; its administrators add a workspace they also
--    administer and remove any other workspace.
-- 3. A row policy for a workspace a workspace's connection serves: that
--    workspace's administrators remove it from their workspace.
--
-- The new policies read subscription_connections, whose visibility routine
-- reads this table as its owner. Each policy therefore starts by excluding the
-- table owner, so the routine never evaluates them and no policy recursion is
-- possible. Organization administrators keep the existing administrator
-- policy. No routine is created or granted. The previous release never assigns
-- a workspace's own connection elsewhere (it cleared the owner first), so it
-- runs unchanged against this schema.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DROP TRIGGER IF EXISTS subscription_connection_workspaces_owner_reach
  ON subscription_connection_workspaces;
DROP TRIGGER IF EXISTS subscription_connections_owner_reach
  ON subscription_connections;

-- The managing workspace's context reads every workspace its connection serves.
CREATE POLICY subscription_connection_workspaces_manager_read ON subscription_connection_workspaces
  FOR SELECT
  USING (
    CURRENT_USER <> pg_get_userbyid((SELECT relation.relowner FROM pg_class relation
      WHERE relation.oid = 'subscription_connection_workspaces'::regclass))
    AND nullif(current_setting('opengeni.workspace_id', true), '') IS NOT NULL
    AND account_id::text = nullif(current_setting('opengeni.account_id', true), '')
    AND EXISTS (SELECT 1 FROM subscription_connections connection
      WHERE connection.account_id = subscription_connection_workspaces.account_id
        AND connection.id = subscription_connection_workspaces.connection_id
        AND connection.ownership = 'shared'
        AND connection.managed_by_workspace_id =
          nullif(current_setting('opengeni.workspace_id', true), '')::uuid)
  );

-- The managing workspace's administrators add a workspace they also administer.
CREATE POLICY subscription_connection_workspaces_manager_share ON subscription_connection_workspaces
  FOR INSERT
  WITH CHECK (
    CURRENT_USER <> pg_get_userbyid((SELECT relation.relowner FROM pg_class relation
      WHERE relation.oid = 'subscription_connection_workspaces'::regclass))
    AND nullif(current_setting('opengeni.workspace_id', true), '') IS NOT NULL
    AND account_id::text = nullif(current_setting('opengeni.account_id', true), '')
    AND workspace_id <> nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM subscription_connections connection
      WHERE connection.account_id = subscription_connection_workspaces.account_id
        AND connection.id = subscription_connection_workspaces.connection_id
        AND connection.ownership = 'shared' AND connection.disconnected_at IS NULL
        AND connection.managed_by_workspace_id =
          nullif(current_setting('opengeni.workspace_id', true), '')::uuid)
    AND EXISTS (SELECT 1 FROM workspace_memberships manager
      WHERE manager.account_id = subscription_connection_workspaces.account_id
        AND manager.workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        AND manager.subject_id = nullif(current_setting('opengeni.subject_id', true), '')
        AND opengeni_private.workspace_membership_administers(manager.role, manager.permissions))
    AND EXISTS (SELECT 1 FROM workspace_memberships receiver
      WHERE receiver.account_id = subscription_connection_workspaces.account_id
        AND receiver.workspace_id = subscription_connection_workspaces.workspace_id
        AND receiver.subject_id = nullif(current_setting('opengeni.subject_id', true), '')
        AND opengeni_private.workspace_membership_administers(receiver.role, receiver.permissions))
  );

-- The managing workspace's administrators remove any other workspace.
CREATE POLICY subscription_connection_workspaces_manager_remove ON subscription_connection_workspaces
  FOR DELETE
  USING (
    CURRENT_USER <> pg_get_userbyid((SELECT relation.relowner FROM pg_class relation
      WHERE relation.oid = 'subscription_connection_workspaces'::regclass))
    AND nullif(current_setting('opengeni.workspace_id', true), '') IS NOT NULL
    AND account_id::text = nullif(current_setting('opengeni.account_id', true), '')
    AND workspace_id <> nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM subscription_connections connection
      WHERE connection.account_id = subscription_connection_workspaces.account_id
        AND connection.id = subscription_connection_workspaces.connection_id
        AND connection.ownership = 'shared'
        AND connection.managed_by_workspace_id =
          nullif(current_setting('opengeni.workspace_id', true), '')::uuid)
    AND EXISTS (SELECT 1 FROM workspace_memberships manager
      WHERE manager.account_id = subscription_connection_workspaces.account_id
        AND manager.workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        AND manager.subject_id = nullif(current_setting('opengeni.subject_id', true), '')
        AND opengeni_private.workspace_membership_administers(manager.role, manager.permissions))
  );

-- A served workspace's administrators remove another workspace's connection
-- from their own workspace (never their own workspace's connection: that one is
-- disconnected instead).
CREATE POLICY subscription_connection_workspaces_receiver_remove ON subscription_connection_workspaces
  FOR DELETE
  USING (
    CURRENT_USER <> pg_get_userbyid((SELECT relation.relowner FROM pg_class relation
      WHERE relation.oid = 'subscription_connection_workspaces'::regclass))
    AND nullif(current_setting('opengeni.workspace_id', true), '') IS NOT NULL
    AND account_id::text = nullif(current_setting('opengeni.account_id', true), '')
    AND workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM subscription_connections connection
      WHERE connection.account_id = subscription_connection_workspaces.account_id
        AND connection.id = subscription_connection_workspaces.connection_id
        AND connection.ownership = 'shared'
        AND connection.managed_by_workspace_id IS NOT NULL
        AND connection.managed_by_workspace_id <> subscription_connection_workspaces.workspace_id)
    AND EXISTS (SELECT 1 FROM workspace_memberships receiver
      WHERE receiver.account_id = subscription_connection_workspaces.account_id
        AND receiver.workspace_id = subscription_connection_workspaces.workspace_id
        AND receiver.subject_id = nullif(current_setting('opengeni.subject_id', true), '')
        AND opengeni_private.workspace_membership_administers(receiver.role, receiver.permissions))
  );
