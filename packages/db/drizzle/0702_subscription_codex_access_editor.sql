-- deployment-mode: rolling
-- Editing what a shared Codex connection serves on the subscription core: its
-- models and, for an organization connection, the workspaces that may use it.
--
-- 1. `access_version` is the optimistic-concurrency version of that access
--    policy alone. The row `version` also moves on every credential refresh,
--    so it would turn routine token refreshes into false edit conflicts.
-- 2. A workspace admin may change the models of a connection their workspace
--    manages (legacy workspace accounts allowed exactly this). Every other
--    scope, ownership and model change stays organization-admin only.
-- 3. The owner-only auto-assignment row (migration 0689) keeps an
--    organization connection's reach to workspaces created later. The editor
--    reads and replaces it through two narrow helpers that require an
--    organization administrator; the runtime role still never touches the
--    table directly.
SET LOCAL lock_timeout = '5s';

ALTER TABLE subscription_connections
  ADD COLUMN access_version integer NOT NULL DEFAULT 1;

DO $install$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.guard_subscription_connection_scope()
    RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    BEGIN
      IF TG_OP = 'UPDATE' AND (
          NEW.account_id IS DISTINCT FROM OLD.account_id
          OR NEW.provider IS DISTINCT FROM OLD.provider
          OR NEW.kind IS DISTINCT FROM OLD.kind
          OR NEW.ownership IS DISTINCT FROM OLD.ownership
          OR NEW.owner_organization_membership_id IS DISTINCT FROM OLD.owner_organization_membership_id
          OR NEW.owner_subject_id IS DISTINCT FROM OLD.owner_subject_id
          OR NEW.authority_id IS DISTINCT FROM OLD.authority_id
          OR NEW.authority_resource_kind IS DISTINCT FROM OLD.authority_resource_kind
          OR NEW.authority_generation IS DISTINCT FROM OLD.authority_generation
          OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
          OR NEW.allow_personal_workspaces IS DISTINCT FROM OLD.allow_personal_workspaces
          OR NEW.managed_by_workspace_id IS DISTINCT FROM OLD.managed_by_workspace_id
          OR NEW.excluded_models IS DISTINCT FROM OLD.excluded_models
      ) AND NOT opengeni_private.subscription_organization_admin(OLD.account_id) THEN
        RAISE EXCEPTION 'only organization administrators may change subscription connection scope or ownership'
          USING ERRCODE = '42501';
      END IF;
      -- The models of a workspace-managed shared connection are also its
      -- managing workspace's admins' decision, in that workspace's context.
      IF TG_OP = 'UPDATE' AND NEW.allowed_model_ids IS DISTINCT FROM OLD.allowed_model_ids
        AND NOT (OLD.ownership = 'shared' AND OLD.managed_by_workspace_id IS NOT NULL
          AND OLD.managed_by_workspace_id::text = nullif(current_setting('opengeni.workspace_id', true), '')
          AND EXISTS (SELECT 1 FROM workspace_memberships manager
            WHERE manager.account_id = OLD.account_id
              AND manager.workspace_id = OLD.managed_by_workspace_id
              AND manager.subject_id = nullif(current_setting('opengeni.subject_id', true), '')
              AND manager.role = 'admin'))
        AND NOT opengeni_private.subscription_organization_admin(OLD.account_id) THEN
        RAISE EXCEPTION 'only organization administrators may change subscription connection scope or ownership'
          USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END
    $body$
  $ddl$, data_schema);

  -- The reach an organization connection keeps for workspaces created later,
  -- or null when it has none. Organization administrators only.
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_codex_reach(p_account_id uuid, p_connection_id uuid)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE reach jsonb;
    BEGIN
      IF NOT opengeni_private.subscription_organization_admin(p_account_id) THEN
        RAISE EXCEPTION 'only organization administrators may read Codex connection reach'
          USING ERRCODE = '42501';
      END IF;
      SELECT pg_catalog.jsonb_build_object(
          'sharedWorkspaces', auto.shared_workspaces,
          'personalWorkspaces', auto.personal_workspaces)
        INTO reach
      FROM opengeni_private.subscription_codex_auto_assignments auto
      WHERE auto.account_id = p_account_id AND auto.connection_id = p_connection_id;
      RETURN reach;
    END
    $body$
  $ddl$, data_schema);

  -- Replace (or with NULL reach, refresh) the auto-assignment row of an
  -- organization-managed shared Codex connection from its current policy.
  -- Neither reach removes the row. Organization administrators only.
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.set_subscription_codex_reach(
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
      SELECT connection.allocator_enabled, connection.allowed_model_ids INTO target
      FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.provider = 'codex' AND connection.kind = 'subscription'
        AND connection.ownership = 'shared' AND connection.managed_by_workspace_id IS NULL;
      IF NOT FOUND THEN
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

REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_reach(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.set_subscription_codex_reach(uuid, uuid, boolean, boolean) FROM PUBLIC;
DO $grant_codex_reach$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_codex_reach(uuid, uuid) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.set_subscription_codex_reach(uuid, uuid, boolean, boolean) TO opengeni_app;
  END IF;
END
$grant_codex_reach$;
