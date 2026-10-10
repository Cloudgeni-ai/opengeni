-- deployment-mode: rolling
-- Workspace-managed shared connections are organization accounts (design
-- 5.4): the organization's access editor may choose their reach for
-- workspaces created later, as for any other organization account.
--
-- Since 0689 a legacy workspace credential in a shared workspace is already
-- a shared connection of the organization (`workspaces` scope over that
-- workspace, its local assignment policy, `managed_by_workspace_id` naming the
-- workspace as its delegated manager). Nothing is moved or rewritten here: no
-- row of any table changes, so a drained cutover would move zero rows (the
-- design records why this is rolling). The only change is that the reach
-- helper behind the editor (0702) also accepts a connection a shared
-- workspace manages. It stays organization-administrator only, and a shared
-- connection managed by a Personal workspace (which no writer produces) is
-- still refused. Grants, owner and search path are unchanged.
SET LOCAL lock_timeout = '5s';

DO $install$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.set_subscription_codex_reach(
      p_account_id uuid, p_connection_id uuid, p_shared boolean, p_personal boolean
    ) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      target record;
      shared_reach boolean := p_shared;
      personal_reach boolean := p_personal;
    BEGIN
      IF NOT opengeni_private.subscription_organization_admin(p_account_id) THEN
        RAISE EXCEPTION 'only organization administrators may change Codex connection reach'
          USING ERRCODE = '42501';
      END IF;
      IF (p_shared IS NULL) <> (p_personal IS NULL) THEN
        RAISE EXCEPTION 'Codex connection reach is set as a pair' USING ERRCODE = '22023';
      END IF;
      SELECT connection.allocator_enabled, connection.allowed_model_ids,
          connection.managed_by_workspace_id INTO target
      FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.provider = 'codex' AND connection.kind = 'subscription'
        AND connection.ownership = 'shared';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'organization Codex connection not found' USING ERRCODE = 'P0002';
      END IF;
      -- A delegated manager must be a shared workspace of the organization
      -- (the inventory also refuses any caller outside organization context).
      IF target.managed_by_workspace_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM %1$I.list_organization_workspace_ids(p_account_id) inventory
          WHERE inventory.workspace_id = target.managed_by_workspace_id) THEN
        RAISE EXCEPTION 'organization Codex connection not found' USING ERRCODE = 'P0002';
      END IF;
      IF p_shared IS NULL THEN
        SELECT auto.shared_workspaces, auto.personal_workspaces INTO shared_reach, personal_reach
        FROM opengeni_private.subscription_codex_auto_assignments auto
        WHERE auto.account_id = p_account_id AND auto.connection_id = p_connection_id;
        IF NOT FOUND THEN
          RETURN;
        END IF;
      END IF;
      IF NOT (shared_reach OR personal_reach) THEN
        DELETE FROM opengeni_private.subscription_codex_auto_assignments auto
        WHERE auto.account_id = p_account_id AND auto.connection_id = p_connection_id;
        RETURN;
      END IF;
      INSERT INTO opengeni_private.subscription_codex_auto_assignments AS auto (
        account_id, connection_id, shared_workspaces, personal_workspaces,
        allocator_enabled, allowed_model_ids
      ) VALUES (
        p_account_id, p_connection_id, shared_reach, personal_reach,
        target.allocator_enabled, target.allowed_model_ids
      )
      ON CONFLICT (connection_id) DO UPDATE SET
        shared_workspaces = excluded.shared_workspaces,
        personal_workspaces = excluded.personal_workspaces,
        allocator_enabled = excluded.allocator_enabled,
        allowed_model_ids = excluded.allowed_model_ids
      WHERE auto.account_id = excluded.account_id;
    END
    $body$
  $ddl$, data_schema);
END
$install$;

REVOKE ALL ON FUNCTION opengeni_private.set_subscription_codex_reach(uuid, uuid, boolean, boolean) FROM PUBLIC;
DO $grant_codex_reach$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.set_subscription_codex_reach(uuid, uuid, boolean, boolean) TO opengeni_app;
  END IF;
END
$grant_codex_reach$;
