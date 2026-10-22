-- deployment-mode: rolling
-- Provider-keyed organization reach, auto-assignment, plan-change history and
-- workspace inventory on the shared subscription core (design
-- docs/design/subscription-core-2026-10-07.md, 5.3 "PR 0c: provider-keyed
-- cutover planner and organization reach"). Migrations 0422, 0689 and 0702
-- shipped these for Codex only; a later provider's cutover uses the same
-- rows and routines with its provider as data.
--
-- Rolling: Codex behaviour is unchanged. Every Codex-named routine keeps its
-- name, signature, owner and grants for binaries that still call it; those
-- that act on the reach rows or the plan-change history are redefined in
-- place to act on the provider-keyed data. Nothing is renamed, detached or
-- dropped: the provider-free names of the reach table, the two
-- auto-assignment triggers, their policies and setting, and the reach rows'
-- connection-and-provider key, and dropping the reach rows' Codex default,
-- come with the maintenance retirement migration, when no older binary can
-- run.
--
-- Locks: the two tables below, taken first and in this order, and no other
-- table. ACCESS EXCLUSIVE on the owner-only reach table, which only 0689's
-- workspace and Personal-workspace triggers, 0702's reach helpers and the
-- referential cascades from deleting a subscription connection or an
-- organization touch, then SHARE ROW EXCLUSIVE on the owner-only provider
-- registry, which runtime transactions only read (no runtime lock conflicts
-- with it). Nothing locks workspaces, organization_memberships,
-- subscription_connections or the assignment tables: every other statement
-- acts on those two tables, creates a table or a view, or creates or replaces
-- a routine. While it waits for its first lock this migration holds nothing a
-- runtime transaction waits for, and afterwards it waits for no lock a
-- runtime transaction holds, so it cannot close a lock cycle with runtime
-- work (which takes the workspace prefix first and the subscription tables
-- after it).
--
-- 1. opengeni_private.subscription_core_plan_change_providers: the providers
--    whose adapters keep plan-change history in provider state, keyed by the
--    registry. Only Codex. (A registry column would take ACCESS EXCLUSIVE on
--    the registry, which session and turn routines read after the workspace
--    prefix.)
-- 2. opengeni_private.subscription_codex_auto_assignments gains `provider`,
--    keyed by the registry, so a row of an unregistered provider cannot
--    exist. Every existing row was written for a Codex connection (0689's
--    cutover and 0702's Codex reach helper write no other), so each is
--    Codex's; from now on the one writer checks the connection's provider.
--    The rows are otherwise kept exactly.
--    The column keeps DEFAULT 'codex' until the retirement migration. An
--    older binary's 0702 reach write that waits for this migration's lock is
--    planned again after the commit, against the new table, and names no
--    provider; without the default it would fail on NOT NULL. Every routine
--    below names the provider.
--    The routines below reach them through the owner-only view
--    opengeni_private.subscription_core_auto_assignments, their provider-free
--    name. The table keeps its 0689 name while older binaries run: a
--    statement that waits for this migration's lock looks its table up by
--    name again once it has the lock, so a rename would fail a workspace
--    creation that straddles the commit. The retirement migration drops the
--    view and gives the table that name.
-- 3. One owner-only apply path for every provider
--    (opengeni_subscription_internal.apply_subscription_core_auto_assignments,
--    0689's body with the provider as data). 0689's two trigger functions run
--    it for each provider with rows in the organization, in provider order;
--    0689's owner-only policies admit its writes for the organization named
--    by their setting, whatever the provider. Its callers (those two trigger
--    functions and the Codex apply routine, which delegates to it) set that
--    setting around each call, so the apply path itself names no provider.
-- 4. Plan-change history by the table in 1: 0689's trigger function tests it
--    instead of a provider literal. It now reads owner data, so it runs as
--    its owner (SECURITY DEFINER, search path pinned, pg_temp last); it still
--    only edits the row being written.
-- 5. Organization reach: opengeni_private.subscription_core_reach and
--    set_subscription_core_reach, 0702's helpers with the provider as data,
--    refusing an unregistered provider. The Codex-named pair keeps its texts
--    and checks, then calls them.
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

-- The whole lock set, in order.
LOCK TABLE opengeni_private.subscription_codex_auto_assignments IN ACCESS EXCLUSIVE MODE;
LOCK TABLE opengeni_private.subscription_core_providers IN SHARE ROW EXCLUSIVE MODE;

-- 1. Plan-change history is a per-provider fact.
CREATE TABLE opengeni_private.subscription_core_plan_change_providers (
  provider text PRIMARY KEY
    REFERENCES opengeni_private.subscription_core_providers(provider)
);
REVOKE ALL ON TABLE opengeni_private.subscription_core_plan_change_providers FROM PUBLIC;
COMMENT ON TABLE opengeni_private.subscription_core_plan_change_providers IS
  'Subscription-core providers whose adapters keep plan-change history (planPreviousType, planChangedAt, planCheckedAt) in provider state. Owner-only.';
INSERT INTO opengeni_private.subscription_core_plan_change_providers (provider) VALUES ('codex');

-- 2. Provider-keyed reach rows: the same rows, each now carrying its
-- connection's provider. The Codex default stays for an older binary's reach
-- write that straddles the commit (see the header).
ALTER TABLE opengeni_private.subscription_codex_auto_assignments
  ADD COLUMN provider text NOT NULL DEFAULT 'codex';
ALTER TABLE opengeni_private.subscription_codex_auto_assignments
  ADD CONSTRAINT subscription_codex_auto_assignments_provider_fkey
    FOREIGN KEY (provider) REFERENCES opengeni_private.subscription_core_providers(provider);
COMMENT ON TABLE opengeni_private.subscription_codex_auto_assignments IS
  'Owner-only reach of an organization connection over workspaces created later, per provider (renamed provider-free at retirement). Runtime roles never read or write it.';
-- Their provider-free name, for every routine below.
CREATE VIEW opengeni_private.subscription_core_auto_assignments AS
SELECT auto.account_id, auto.provider, auto.connection_id, auto.shared_workspaces,
  auto.personal_workspaces, auto.allocator_enabled, auto.allowed_model_ids
FROM opengeni_private.subscription_codex_auto_assignments auto;
REVOKE ALL ON TABLE opengeni_private.subscription_core_auto_assignments FROM PUBLIC;
COMMENT ON VIEW opengeni_private.subscription_core_auto_assignments IS
  'Provider-keyed reach rows of subscription_codex_auto_assignments under their provider-free name; at retirement the table takes this name. Owner-only.';

-- 3-6. The routines.
DO $install$
DECLARE data_schema text := current_schema();
BEGIN
  -- 3. A workspace is first assigned as a shared workspace; when it becomes
  -- someone's Personal workspace the assignment follows the Personal rule
  -- instead. Only the organization pool this mechanism writes is touched; a
  -- workspace's own local copy never is. 0689's owner-only policies on both
  -- assignment tables admit these writes for the organization named by
  -- their setting, which the caller sets.
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_subscription_internal.apply_subscription_core_auto_assignments(
      p_provider text, p_account_id uuid, p_workspace_id uuid, p_personal boolean
    ) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM opengeni_private.subscription_core_auto_assignments auto
          WHERE auto.account_id = p_account_id AND auto.provider = p_provider) THEN
        RETURN;
      END IF;
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
    END
    $body$
  $ddl$, data_schema);
  -- 0689's trigger functions, still attached to its two triggers, apply the
  -- reach of every provider with rows in the organization, in provider
  -- order, each under 0689's setting naming the organization. Owner,
  -- grants, security mode and search path are 0689's.
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.auto_assign_subscription_codex_workspace()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      reach_provider text;
      previous text := current_setting('opengeni.subscription_codex_auto_assign', true);
    BEGIN
      FOR reach_provider IN SELECT DISTINCT auto.provider
          FROM opengeni_private.subscription_core_auto_assignments auto
          WHERE auto.account_id = NEW.account_id ORDER BY auto.provider LOOP
        PERFORM pg_catalog.set_config('opengeni.subscription_codex_auto_assign',
          NEW.account_id::text, true);
        PERFORM opengeni_subscription_internal.apply_subscription_core_auto_assignments(
          reach_provider, NEW.account_id, NEW.id, false);
        PERFORM pg_catalog.set_config('opengeni.subscription_codex_auto_assign',
          coalesce(previous, ''), true);
      END LOOP;
      RETURN NEW;
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.auto_assign_subscription_codex_personal_workspace()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      reach_provider text;
      previous text := current_setting('opengeni.subscription_codex_auto_assign', true);
    BEGIN
      IF NEW.personal_workspace_id IS NOT NULL AND (TG_OP = 'INSERT'
          OR NEW.personal_workspace_id IS DISTINCT FROM OLD.personal_workspace_id) THEN
        FOR reach_provider IN SELECT DISTINCT auto.provider
            FROM opengeni_private.subscription_core_auto_assignments auto
            WHERE auto.account_id = NEW.account_id ORDER BY auto.provider LOOP
          PERFORM pg_catalog.set_config('opengeni.subscription_codex_auto_assign',
            NEW.account_id::text, true);
          PERFORM opengeni_subscription_internal.apply_subscription_core_auto_assignments(
            reach_provider, NEW.account_id, NEW.personal_workspace_id, true);
          PERFORM pg_catalog.set_config('opengeni.subscription_codex_auto_assign',
            coalesce(previous, ''), true);
        END LOOP;
      END IF;
      RETURN NEW;
    END
    $body$
  $ddl$, data_schema);
  -- The Codex-named apply routine acts on its provider's rows, under 0689's
  -- setting as before.
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.apply_subscription_codex_auto_assignments(
      p_account_id uuid, p_workspace_id uuid, p_personal boolean
    ) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE previous text := current_setting('opengeni.subscription_codex_auto_assign', true);
    BEGIN
      PERFORM pg_catalog.set_config('opengeni.subscription_codex_auto_assign',
        p_account_id::text, true);
      PERFORM opengeni_subscription_internal.apply_subscription_core_auto_assignments(
        'codex', p_account_id, p_workspace_id, p_personal);
      PERFORM pg_catalog.set_config('opengeni.subscription_codex_auto_assign',
        coalesce(previous, ''), true);
    END
    $body$
  $ddl$, data_schema);

  -- 4. Plan-change history (the legacy plan_previous_type and
  -- plan_changed_at columns): any writer that changes the plan of a
  -- connection whose provider keeps this history, such as a refresh whose
  -- token carries a new plan, records the previous plan and when it changed
  -- in adapter-owned provider state. 0689's function, still attached to its
  -- BEFORE UPDATE OF plan_type trigger.
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.record_subscription_codex_plan_change()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    BEGIN
      IF OLD.plan_type IS NOT NULL AND NEW.plan_type IS NOT NULL
        AND lower(NEW.plan_type) IS DISTINCT FROM lower(OLD.plan_type)
        AND EXISTS (SELECT 1 FROM opengeni_private.subscription_core_plan_change_providers recorded
          WHERE recorded.provider = NEW.provider)
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
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
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
