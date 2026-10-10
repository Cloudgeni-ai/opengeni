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
-- setters behind the editor (0702, made provider-keyed by 0713) also accept a
-- connection a shared workspace of the organization manages. They stay
-- organization-administrator only, and a shared connection managed by a
-- Personal workspace (which no writer produces) or by a workspace outside
-- the organization is still refused as not found. The read helpers already
-- read any connection's row. Signatures, owners, grants, security mode and
-- search paths are unchanged (CREATE OR REPLACE keeps the grants).
SET LOCAL lock_timeout = '5s';

DO $install$
DECLARE data_schema text := current_schema();
BEGIN
  -- 0713's body, with the manager condition: no manager, or a shared
  -- workspace of the organization (the inventory also refuses any caller
  -- outside organization context).
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.set_subscription_core_reach(
      p_provider text, p_account_id uuid, p_connection_id uuid, p_shared boolean, p_personal boolean
    ) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      target record;
      shared_reach boolean := p_shared;
      personal_reach boolean := p_personal;
    BEGIN
      IF NOT opengeni_private.subscription_organization_admin(p_account_id) THEN
        RAISE EXCEPTION 'only organization administrators may change subscription connection reach'
          USING ERRCODE = '42501';
      END IF;
      IF (p_shared IS NULL) <> (p_personal IS NULL) THEN
        RAISE EXCEPTION 'subscription connection reach is set as a pair' USING ERRCODE = '22023';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM opengeni_private.subscription_core_providers registry
          WHERE registry.provider = p_provider) THEN
        RAISE EXCEPTION 'subscription provider is not registered on the shared core'
          USING ERRCODE = '22023';
      END IF;
      SELECT connection.allocator_enabled, connection.allowed_model_ids,
          connection.managed_by_workspace_id INTO target
      FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.provider = p_provider AND connection.kind = 'subscription'
        AND connection.ownership = 'shared';
      IF NOT FOUND OR (target.managed_by_workspace_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM %1$I.list_organization_workspace_ids(p_account_id) inventory
          WHERE inventory.workspace_id = target.managed_by_workspace_id)) THEN
        RAISE EXCEPTION 'organization subscription connection not found' USING ERRCODE = 'P0002';
      END IF;
      IF p_shared IS NULL THEN
        SELECT auto.shared_workspaces, auto.personal_workspaces INTO shared_reach, personal_reach
        FROM opengeni_private.subscription_core_auto_assignments auto
        WHERE auto.account_id = p_account_id AND auto.provider = p_provider
          AND auto.connection_id = p_connection_id;
        IF NOT FOUND THEN
          RETURN;
        END IF;
      END IF;
      IF NOT (shared_reach OR personal_reach) THEN
        DELETE FROM opengeni_private.subscription_core_auto_assignments auto
        WHERE auto.account_id = p_account_id AND auto.provider = p_provider
          AND auto.connection_id = p_connection_id;
        RETURN;
      END IF;
      INSERT INTO opengeni_private.subscription_core_auto_assignments AS auto (
        account_id, provider, connection_id, shared_workspaces, personal_workspaces,
        allocator_enabled, allowed_model_ids
      ) VALUES (
        p_account_id, p_provider, p_connection_id, shared_reach, personal_reach,
        target.allocator_enabled, target.allowed_model_ids
      )
      ON CONFLICT (connection_id) DO UPDATE SET
        shared_workspaces = excluded.shared_workspaces,
        personal_workspaces = excluded.personal_workspaces,
        allocator_enabled = excluded.allocator_enabled,
        allowed_model_ids = excluded.allowed_model_ids
      WHERE auto.account_id = excluded.account_id AND auto.provider = excluded.provider;
    END
    $body$
  $ddl$, data_schema);

  -- The Codex-named setter keeps its texts and checks, with the same manager
  -- condition, then acts through the neutral routine.
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.set_subscription_codex_reach(
      p_account_id uuid, p_connection_id uuid, p_shared boolean, p_personal boolean
    ) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    BEGIN
      IF NOT opengeni_private.subscription_organization_admin(p_account_id) THEN
        RAISE EXCEPTION 'only organization administrators may change Codex connection reach'
          USING ERRCODE = '42501';
      END IF;
      IF (p_shared IS NULL) <> (p_personal IS NULL) THEN
        RAISE EXCEPTION 'Codex connection reach is set as a pair' USING ERRCODE = '22023';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM subscription_connections connection
          WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
            AND connection.provider = 'codex' AND connection.kind = 'subscription'
            AND connection.ownership = 'shared'
            AND (connection.managed_by_workspace_id IS NULL OR EXISTS (
              SELECT 1 FROM %1$I.list_organization_workspace_ids(p_account_id) inventory
              WHERE inventory.workspace_id = connection.managed_by_workspace_id))) THEN
        RAISE EXCEPTION 'organization Codex connection not found' USING ERRCODE = 'P0002';
      END IF;
      PERFORM opengeni_private.set_subscription_core_reach(
        'codex', p_account_id, p_connection_id, p_shared, p_personal);
    END
    $body$
  $ddl$, data_schema);
END
$install$;
