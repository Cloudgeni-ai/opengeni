-- deployment-mode: rolling
-- Provider-keyed organization reach, auto-assignment, plan-change history and
-- workspace inventory on the shared subscription core (design
-- docs/design/subscription-core-2026-10-07.md, 5.3 "PR 0c: provider-keyed
-- cutover planner and organization reach"). Migrations 0422, 0689 and 0702
-- shipped these for Codex only; a later provider's cutover uses the same
-- rows and routines with its provider as data.
--
-- Rolling: Codex behaviour is unchanged. Every Codex-named routine keeps its
-- signature, owner, grants, security mode and search path for binaries that
-- still call them; the three that read the auto-assignment rows are
-- redefined to act on the provider-keyed rows (the reach pair with its own
-- texts and checks first, then the neutral routine). A retirement migration
-- drops the Codex-named routines, triggers functions and policies once no
-- older binary can run.
--
-- 1. The registry gains `records_plan_change`: whether a provider keeps its
--    plan-change history in adapter-owned provider state. Only Codex does.
-- 2. opengeni_private.subscription_codex_auto_assignments becomes
--    opengeni_private.subscription_core_auto_assignments: the same rows,
--    each now carrying its connection's provider. Every existing row was
--    written for a Codex connection (0689's cutover, 0702's Codex reach
--    helper); the provider-keyed foreign key proves it, so any other row
--    aborts the migration. Validating that key is the only owner read of a
--    FORCE-RLS table here, inside an owner-only NO FORCE window around that
--    one statement. A row of an unregistered provider cannot exist.
-- 3. One owner-only apply path for every provider
--    (opengeni_subscription_internal.apply_subscription_core_auto_assignments,
--    0689's body with the provider as data), run by provider-free triggers on
--    workspace and Personal-workspace creation that replace 0689's two Codex
--    triggers, for each provider with rows in the organization. Owner-only
--    policies keyed on a provider-free setting admit its writes, one for one
--    with 0689's Codex policies (which stay until retirement). The Codex
--    apply routine delegates to it.
-- 4. Plan-change history by registry flag: a provider-free trigger replaces
--    0689's Codex plan-change trigger (its function stays, detached).
-- 5. Organization reach: opengeni_private.subscription_core_reach and
--    set_subscription_core_reach, 0702's helpers with the provider as data,
--    refusing an unregistered provider. The Codex-named pair keeps its texts.
-- 6. list_organization_subscription_workspace_ids: 0422's content-free
--    inventory (shared and Personal workspaces) under a provider-free name
--    for the shared core's capacity wakes. The Codex-named inventory stays
--    as it is.
--
-- New owner-only routines live in opengeni_subscription_internal (a previous
-- binary's readiness rejects any opengeni_private routine it cannot execute
-- unless it knows it); new runtime routines are granted to the application
-- roles here, so a previous binary's readiness holds before roles are
-- provisioned again.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- 1. Plan-change history is a per-provider fact.
ALTER TABLE opengeni_private.subscription_core_providers
  ADD COLUMN records_plan_change boolean NOT NULL DEFAULT false;
UPDATE opengeni_private.subscription_core_providers SET records_plan_change = true
WHERE provider = 'codex';

-- 2. Provider-keyed auto-assignment rows: renamed in place, so every existing
-- row is kept exactly.
ALTER TABLE opengeni_private.subscription_codex_auto_assignments
  RENAME TO subscription_core_auto_assignments;
ALTER TABLE opengeni_private.subscription_core_auto_assignments
  RENAME CONSTRAINT subscription_codex_auto_assignments_pkey TO subscription_core_auto_assignments_pkey;
ALTER TABLE opengeni_private.subscription_core_auto_assignments
  RENAME CONSTRAINT subscription_codex_auto_assignments_check TO subscription_core_auto_assignments_reach_chk;
ALTER INDEX opengeni_private.subscription_codex_auto_assignments_account_idx
  RENAME TO subscription_core_auto_assignments_account_idx;
ALTER TABLE opengeni_private.subscription_core_auto_assignments
  ADD COLUMN provider text NOT NULL DEFAULT 'codex';
ALTER TABLE opengeni_private.subscription_core_auto_assignments
  ALTER COLUMN provider DROP DEFAULT;
-- The (account, connection) key 0689 declared is replaced by the
-- provider-keyed one at the end of this migration (its generated name is
-- truncated, so look it up).
DO $auto_assignment_keys$
DECLARE legacy_key text;
BEGIN
  SELECT constraint_row.conname INTO STRICT legacy_key
  FROM pg_catalog.pg_constraint constraint_row
  WHERE constraint_row.conrelid = 'opengeni_private.subscription_core_auto_assignments'::regclass
    AND constraint_row.contype = 'f';
  EXECUTE format('ALTER TABLE opengeni_private.subscription_core_auto_assignments DROP CONSTRAINT %I',
    legacy_key);
END
$auto_assignment_keys$;
ALTER TABLE opengeni_private.subscription_core_auto_assignments
  ADD CONSTRAINT subscription_core_auto_assignments_provider_fk
    FOREIGN KEY (provider) REFERENCES opengeni_private.subscription_core_providers(provider);
COMMENT ON TABLE opengeni_private.subscription_core_auto_assignments IS
  'Owner-only reach of an organization connection over workspaces created later, per provider. Runtime roles never read or write it.';

-- 3-5. The routines.
DO $install$
DECLARE data_schema text := current_schema();
BEGIN
  -- 3. Auto-assignment writes, admitted for the one organization the apply
  -- routine is working on, and only for the table owner.
  EXECUTE format($ddl$
    CREATE POLICY subscription_connection_workspaces_core_auto_assign
    ON %1$I.subscription_connection_workspaces FOR ALL
    USING (CURRENT_USER = pg_catalog.pg_get_userbyid((SELECT relation.relowner
        FROM pg_catalog.pg_class relation
        WHERE relation.oid = '%1$I.subscription_connection_workspaces'::regclass))
      AND current_setting('opengeni.subscription_core_auto_assign', true) = account_id::text)
    WITH CHECK (CURRENT_USER = pg_catalog.pg_get_userbyid((SELECT relation.relowner
        FROM pg_catalog.pg_class relation
        WHERE relation.oid = '%1$I.subscription_connection_workspaces'::regclass))
      AND current_setting('opengeni.subscription_core_auto_assign', true) = account_id::text)
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE POLICY subscription_connection_assignment_policies_core_auto_assign
    ON %1$I.subscription_connection_assignment_policies FOR ALL
    USING (CURRENT_USER = pg_catalog.pg_get_userbyid((SELECT relation.relowner
        FROM pg_catalog.pg_class relation
        WHERE relation.oid = '%1$I.subscription_connection_assignment_policies'::regclass))
      AND current_setting('opengeni.subscription_core_auto_assign', true) = account_id::text)
    WITH CHECK (CURRENT_USER = pg_catalog.pg_get_userbyid((SELECT relation.relowner
        FROM pg_catalog.pg_class relation
        WHERE relation.oid = '%1$I.subscription_connection_assignment_policies'::regclass))
      AND current_setting('opengeni.subscription_core_auto_assign', true) = account_id::text)
  $ddl$, data_schema);

  -- A workspace is first assigned as a shared workspace; when it becomes
  -- someone's Personal workspace the assignment follows the Personal rule
  -- instead. Only the organization pool this mechanism writes is touched; a
  -- workspace's own local copy never is.
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_subscription_internal.apply_subscription_core_auto_assignments(
      p_provider text, p_account_id uuid, p_workspace_id uuid, p_personal boolean
    ) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE previous text := current_setting('opengeni.subscription_core_auto_assign', true);
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM opengeni_private.subscription_core_auto_assignments auto
          WHERE auto.account_id = p_account_id AND auto.provider = p_provider) THEN
        RETURN;
      END IF;
      PERFORM pg_catalog.set_config('opengeni.subscription_core_auto_assign', p_account_id::text, true);
      DELETE FROM subscription_connection_assignment_policies policy
      USING opengeni_private.subscription_core_auto_assignments auto
      WHERE auto.account_id = p_account_id AND auto.provider = p_provider
        AND policy.account_id = p_account_id
        AND policy.connection_id = auto.connection_id AND policy.workspace_id = p_workspace_id
        AND policy.inference_pool = 'organization'
        AND NOT (CASE WHEN p_personal THEN auto.personal_workspaces ELSE auto.shared_workspaces END);
      DELETE FROM subscription_connection_workspaces assignment
      USING opengeni_private.subscription_core_auto_assignments auto
      WHERE auto.account_id = p_account_id AND auto.provider = p_provider
        AND assignment.account_id = p_account_id
        AND assignment.connection_id = auto.connection_id AND assignment.workspace_id = p_workspace_id
        AND NOT (CASE WHEN p_personal THEN auto.personal_workspaces ELSE auto.shared_workspaces END)
        AND NOT EXISTS (SELECT 1 FROM subscription_connection_assignment_policies policy
          WHERE policy.account_id = p_account_id AND policy.connection_id = auto.connection_id
            AND policy.workspace_id = p_workspace_id);
      INSERT INTO subscription_connection_workspaces (account_id, connection_id, workspace_id)
      SELECT p_account_id, auto.connection_id, p_workspace_id
      FROM opengeni_private.subscription_core_auto_assignments auto
      WHERE auto.account_id = p_account_id AND auto.provider = p_provider
        AND CASE WHEN p_personal THEN auto.personal_workspaces ELSE auto.shared_workspaces END
        AND NOT EXISTS (SELECT 1 FROM subscription_connection_workspaces assignment
          WHERE assignment.account_id = p_account_id AND assignment.connection_id = auto.connection_id
            AND assignment.workspace_id = p_workspace_id);
      INSERT INTO subscription_connection_assignment_policies (
        account_id, connection_id, workspace_id, inference_pool, allocator_enabled,
        allowed_model_ids, excluded_models, managed_by_workspace_id
      )
      SELECT p_account_id, auto.connection_id, p_workspace_id, 'organization',
        auto.allocator_enabled, auto.allowed_model_ids, '{}'::text[], NULL
      FROM opengeni_private.subscription_core_auto_assignments auto
      WHERE auto.account_id = p_account_id AND auto.provider = p_provider
        AND CASE WHEN p_personal THEN auto.personal_workspaces ELSE auto.shared_workspaces END
        AND NOT EXISTS (SELECT 1 FROM subscription_connection_assignment_policies policy
          WHERE policy.account_id = p_account_id AND policy.connection_id = auto.connection_id
            AND policy.workspace_id = p_workspace_id AND policy.inference_pool = 'organization');
      PERFORM pg_catalog.set_config('opengeni.subscription_core_auto_assign', coalesce(previous, ''), true);
    END
    $body$
  $ddl$, data_schema);
  -- Every provider with reach rows in the organization, in provider order.
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_subscription_internal.auto_assign_subscription_core_workspace()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE reach_provider text;
    BEGIN
      FOR reach_provider IN SELECT DISTINCT auto.provider
          FROM opengeni_private.subscription_core_auto_assignments auto
          WHERE auto.account_id = NEW.account_id ORDER BY auto.provider LOOP
        PERFORM opengeni_subscription_internal.apply_subscription_core_auto_assignments(
          reach_provider, NEW.account_id, NEW.id, false);
      END LOOP;
      RETURN NEW;
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_subscription_internal.auto_assign_subscription_core_personal_workspace()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE reach_provider text;
    BEGIN
      IF NEW.personal_workspace_id IS NOT NULL AND (TG_OP = 'INSERT'
          OR NEW.personal_workspace_id IS DISTINCT FROM OLD.personal_workspace_id) THEN
        FOR reach_provider IN SELECT DISTINCT auto.provider
            FROM opengeni_private.subscription_core_auto_assignments auto
            WHERE auto.account_id = NEW.account_id ORDER BY auto.provider LOOP
          PERFORM opengeni_subscription_internal.apply_subscription_core_auto_assignments(
            reach_provider, NEW.account_id, NEW.personal_workspace_id, true);
        END LOOP;
      END IF;
      RETURN NEW;
    END
    $body$
  $ddl$, data_schema);
  -- The Codex-named apply routine (fired only by 0689's triggers, which this
  -- migration replaces) acts on the provider-keyed rows of its provider.
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.apply_subscription_codex_auto_assignments(
      p_account_id uuid, p_workspace_id uuid, p_personal boolean
    ) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    BEGIN
      PERFORM opengeni_subscription_internal.apply_subscription_core_auto_assignments(
        'codex', p_account_id, p_workspace_id, p_personal);
    END
    $body$
  $ddl$, data_schema);

  -- 4. Plan-change history (the legacy plan_previous_type and
  -- plan_changed_at columns): any writer that changes the plan of a
  -- connection whose provider keeps this history, such as a refresh whose
  -- token carries a new plan, records the previous plan and when it changed
  -- in adapter-owned provider state.
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_subscription_internal.record_subscription_core_plan_change()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    BEGIN
      IF OLD.plan_type IS NOT NULL AND NEW.plan_type IS NOT NULL
        AND lower(NEW.plan_type) IS DISTINCT FROM lower(OLD.plan_type)
        AND EXISTS (SELECT 1 FROM opengeni_private.subscription_core_providers registry
          WHERE registry.provider = NEW.provider AND registry.records_plan_change)
      THEN
        NEW.provider_state := NEW.provider_state || jsonb_build_object(
          'planPreviousType', OLD.plan_type,
          'planChangedAt', to_jsonb(clock_timestamp()),
          'planCheckedAt', to_jsonb(clock_timestamp()));
      END IF;
      RETURN NEW;
    END
    $body$
  $ddl$, data_schema);

  -- 5. The reach an organization connection keeps for workspaces created
  -- later, or null when it has none. Organization administrators only.
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_core_reach(
      p_provider text, p_account_id uuid, p_connection_id uuid
    ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE reach jsonb;
    BEGIN
      IF NOT opengeni_private.subscription_organization_admin(p_account_id) THEN
        RAISE EXCEPTION 'only organization administrators may read subscription connection reach'
          USING ERRCODE = '42501';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM opengeni_private.subscription_core_providers registry
          WHERE registry.provider = p_provider) THEN
        RAISE EXCEPTION 'subscription provider is not registered on the shared core'
          USING ERRCODE = '22023';
      END IF;
      SELECT pg_catalog.jsonb_build_object(
          'sharedWorkspaces', auto.shared_workspaces,
          'personalWorkspaces', auto.personal_workspaces)
        INTO reach
      FROM opengeni_private.subscription_core_auto_assignments auto
      WHERE auto.account_id = p_account_id AND auto.provider = p_provider
        AND auto.connection_id = p_connection_id;
      RETURN reach;
    END
    $body$
  $ddl$, data_schema);

  -- Replace (or with NULL reach, refresh) the auto-assignment row of an
  -- organization-managed shared connection from its current policy. Neither
  -- reach removes the row. Organization administrators only.
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.set_subscription_core_reach(
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
      SELECT connection.allocator_enabled, connection.allowed_model_ids INTO target
      FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.provider = p_provider AND connection.kind = 'subscription'
        AND connection.ownership = 'shared' AND connection.managed_by_workspace_id IS NULL;
      IF NOT FOUND THEN
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

  -- The Codex-named pair keeps its texts and checks, then acts through the
  -- neutral routine on the same rows.
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.subscription_codex_reach(p_account_id uuid, p_connection_id uuid)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    BEGIN
      IF NOT opengeni_private.subscription_organization_admin(p_account_id) THEN
        RAISE EXCEPTION 'only organization administrators may read Codex connection reach'
          USING ERRCODE = '42501';
      END IF;
      RETURN opengeni_private.subscription_core_reach('codex', p_account_id, p_connection_id);
    END
    $body$
  $ddl$, data_schema);
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
            AND connection.ownership = 'shared' AND connection.managed_by_workspace_id IS NULL) THEN
        RAISE EXCEPTION 'organization Codex connection not found' USING ERRCODE = 'P0002';
      END IF;
      PERFORM opengeni_private.set_subscription_core_reach(
        'codex', p_account_id, p_connection_id, p_shared, p_personal);
    END
    $body$
  $ddl$, data_schema);

  -- 6. Content-free inventory of every workspace of the organization,
  -- Personal ones included.
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.list_organization_subscription_workspace_ids(p_account_id uuid)
    RETURNS TABLE (workspace_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      previous_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
    BEGIN
      IF p_account_id IS NULL
        OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
        OR opengeni_private.current_workspace_id() IS NOT NULL
      THEN
        RAISE EXCEPTION 'organization subscription workspace inventory authority required'
          USING ERRCODE = '42501';
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        'organization_membership_lifecycle', true
      );

      RETURN QUERY
      SELECT workspace.id
      FROM workspaces workspace
      WHERE workspace.account_id = p_account_id;

      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
      );
      RETURN;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
      );
      RAISE;
    END
    $body$
  $ddl$, data_schema);
END
$install$;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.apply_subscription_core_auto_assignments(
  text, uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_subscription_internal.auto_assign_subscription_core_workspace()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_subscription_internal.auto_assign_subscription_core_personal_workspace()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_subscription_internal.record_subscription_core_plan_change()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.subscription_core_reach(text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.set_subscription_core_reach(text, uuid, uuid, boolean, boolean)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION list_organization_subscription_workspace_ids(uuid) FROM PUBLIC;
COMMENT ON FUNCTION list_organization_subscription_workspace_ids(uuid) IS
  'Content-free same-organization workspace IDs, including Personal, for subscription source fences and capacity wakes only. Grants no workspace access.';

-- The runtime routines go to the configured application roles (and the
-- default one) and to nobody else.
DO $grant_runtime_routines$
DECLARE
  data_schema text := current_schema();
  application_role text;
BEGIN
  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(
        nullif(current_setting('opengeni.migration_application_roles', true), ''),
        '[]'
      )::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value
      ON role_value.rolname = configured.value
    UNION
    SELECT 'opengeni_app'
    WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.subscription_core_reach(text, uuid, uuid) TO %I',
      application_role);
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.set_subscription_core_reach(text, uuid, uuid, boolean, boolean) TO %I',
      application_role);
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.list_organization_subscription_workspace_ids(uuid) TO %I',
      data_schema, application_role);
  END LOOP;
END
$grant_runtime_routines$;

-- 2. Every reach row names its own connection's provider. Validating the key
-- reads subscription_connections as this migration's owner, which FORCE ROW
-- LEVEL SECURITY would hide every row from (a false violation), so the
-- owner-only window is open around this statement alone: the application
-- role stays policy-bound, and a failure rolls both back.
ALTER TABLE "subscription_connections" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.subscription_core_auto_assignments
  ADD CONSTRAINT subscription_core_auto_assignments_connection_fk
    FOREIGN KEY (account_id, provider, connection_id)
    REFERENCES subscription_connections(account_id, provider, id) ON DELETE CASCADE;
ALTER TABLE "subscription_connections" FORCE ROW LEVEL SECURITY;

-- 3-4. The provider-free triggers replace 0689's Codex triggers. Same events,
-- and the names sort into the same place among each table's triggers.
DROP TRIGGER workspaces_subscription_codex_auto_assign ON workspaces;
CREATE TRIGGER workspaces_subscription_core_auto_assign
  AFTER INSERT ON workspaces
  FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.auto_assign_subscription_core_workspace();
DROP TRIGGER organization_memberships_subscription_codex_auto_assign ON organization_memberships;
CREATE TRIGGER organization_memberships_subscription_core_auto_assign
  AFTER INSERT OR UPDATE OF personal_workspace_id ON organization_memberships
  FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.auto_assign_subscription_core_personal_workspace();
DROP TRIGGER subscription_connections_codex_plan_change_trg ON subscription_connections;
CREATE TRIGGER subscription_connections_core_plan_change_trg
  BEFORE UPDATE OF plan_type ON subscription_connections
  FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.record_subscription_core_plan_change();
