-- deployment-mode: rolling
-- online-safety-exception: explicit-lock: the lock holds only the subscription connection, reach, policy and settings tables, which have a few rows per organization or workspace, so the owner rewrite cannot race a concurrent connect and finishes instantly
-- online-safety-exception: unbatched-data: every rewritten table holds a handful of subscription connection, reach or policy rows per organization, so one pass finishes instantly
-- online-safety-exception: constraint-validation: the validated table holds a handful of subscription connection rows per organization, so validating under the same lock finishes instantly
-- contract-step: nothing in this release reads or writes subscription_connection_assignment_policies; a later contract migration drops it. A previous binary that straddles the commit reads no policy rows, so it classifies every shared connection by its manager and the stripped settings (automatic source), which is exactly the reach written here.
--
-- Migration 0907: every subscription connection has one owner and serves
-- exactly where it reaches (docs/subscription-accounts.md D-50, SUB-OWN-01,
-- SUB-OWN-04).
--
-- Before, one connection could sit in a workspace twice: as the workspace's
-- own copy (inference pool `workspace`) and as the organization's (pool
-- `organization`), each with its own on/off switch in
-- subscription_connection_assignment_policies, and a per-workspace preference
-- (`providers.<id>.inferenceSource`, earlier `useOrganizationAccounts`)
-- chose which copies served. This folds that into the connection itself
-- while keeping everyone's access exactly as it was:
--
-- 1. A connection "is used" in a workspace when it is in scope there and,
--    with the workspace's effective preference, an enabled policy row admits
--    it (or, without policy rows, the manager rule does). The connection's
--    own switch is not part of that: it stays as it is.
-- 2. Its reach becomes the workspaces that used it. An organization-wide
--    connection that some workspace did not use becomes a list of the ones
--    that did, and keeps reaching shared workspaces created later. When no
--    workspace used it, its listed reach is kept and it is switched off, so
--    switching it on serves where it was meant to.
-- 3. A connection a workspace manages stays that workspace's own only when
--    it reaches that workspace alone; otherwise it becomes the
--    organization's. A connection no workspace manages whose only use was as
--    one workspace's own copy becomes that workspace's.
-- 4. A model list the admitting policies narrowed in every workspace that
--    used the connection moves onto the connection (the union across those
--    workspaces, so nobody loses a model).
-- 5. Every policy row is removed, the preference keys are stripped from
--    settings, and the reach applied to new workspaces no longer writes
--    policy rows.
--
-- The subscription tables force row security, so the backfill runs in the
-- owner window (docs/force-rls-migration-backfills.md); workspaces and
-- memberships are read through the organization-lifecycle marker branch.
-- No advisory fence is taken.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

LOCK TABLE subscription_connections, subscription_connection_workspaces,
  subscription_connection_assignment_policies, subscription_settings,
  opengeni_private.subscription_core_auto_assignments
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE subscription_connections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_connection_workspaces NO FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_connection_assignment_policies NO FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_settings NO FORCE ROW LEVEL SECURITY;
-- The scope guard admits only organization administrators; this owner-only
-- backfill has no actor, so the guard is off inside this transaction alone.
ALTER TABLE subscription_connections DISABLE TRIGGER subscription_connections_scope_guard;

SELECT pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
  'organization_membership_lifecycle', true);

CREATE TEMP TABLE subscription_one_owner_use ON COMMIT DROP AS
WITH connection AS (
  SELECT connection.id, connection.account_id, connection.provider, connection.scope_kind,
    connection.allow_personal_workspaces, connection.managed_by_workspace_id
  FROM subscription_connections connection
  WHERE connection.ownership = 'shared' AND connection.disconnected_at IS NULL
    AND connection.scope_kind IN ('organization', 'workspaces')
), workspace AS (
  SELECT workspace.account_id, workspace.id,
    EXISTS (SELECT 1 FROM organization_memberships membership
      WHERE membership.account_id = workspace.account_id
        AND membership.personal_workspace_id = workspace.id) AS personal
  FROM workspaces workspace
  WHERE workspace.account_id IN (SELECT account_id FROM connection)
), source AS (
  SELECT workspace.account_id, workspace.id AS workspace_id, provider.provider,
    coalesce(effective->'values'->'providers'->provider.provider->>'inferenceSource',
      CASE WHEN effective->'values'->'providers'->provider.provider->>'useOrganizationAccounts' = 'false'
        THEN 'workspace' ELSE 'automatic' END) AS inference_source
  FROM workspace
  CROSS JOIN LATERAL (SELECT DISTINCT connection.provider FROM connection
    WHERE connection.account_id = workspace.account_id) provider
  CROSS JOIN LATERAL (SELECT subscription_effective_settings(workspace.account_id, workspace.id)
    AS effective) settings
), in_scope AS (
  SELECT connection.id AS connection_id, workspace.id AS workspace_id, workspace.personal,
    EXISTS (SELECT 1 FROM subscription_connection_workspaces assignment
      WHERE assignment.account_id = connection.account_id
        AND assignment.connection_id = connection.id
        AND assignment.workspace_id = workspace.id) AS assigned
  FROM connection JOIN workspace ON workspace.account_id = connection.account_id
  WHERE connection.scope_kind = 'organization'
    OR EXISTS (SELECT 1 FROM subscription_connection_workspaces assignment
      WHERE assignment.account_id = connection.account_id
        AND assignment.connection_id = connection.id
        AND assignment.workspace_id = workspace.id)
    OR (workspace.personal AND connection.allow_personal_workspaces)
)
SELECT in_scope.connection_id, in_scope.workspace_id, in_scope.personal, in_scope.assigned,
  source.inference_source,
  CASE
    WHEN EXISTS (SELECT 1 FROM subscription_connection_assignment_policies policy
        WHERE policy.connection_id = in_scope.connection_id
          AND policy.workspace_id = in_scope.workspace_id)
      THEN EXISTS (SELECT 1 FROM subscription_connection_assignment_policies policy
        WHERE policy.connection_id = in_scope.connection_id
          AND policy.workspace_id = in_scope.workspace_id
          AND policy.allocator_enabled
          AND (source.inference_source = 'automatic'
            OR policy.inference_pool = source.inference_source))
    WHEN source.inference_source = 'workspace'
      THEN connection.managed_by_workspace_id IS NOT DISTINCT FROM in_scope.workspace_id
    WHEN source.inference_source = 'organization'
      THEN connection.managed_by_workspace_id IS DISTINCT FROM in_scope.workspace_id
    ELSE true
  END AS used,
  (EXISTS (SELECT 1 FROM subscription_connection_assignment_policies policy
      WHERE policy.connection_id = in_scope.connection_id
        AND policy.workspace_id = in_scope.workspace_id
        AND policy.inference_pool = 'workspace')
    OR (in_scope.assigned
      AND connection.managed_by_workspace_id IS NOT DISTINCT FROM in_scope.workspace_id
      AND NOT EXISTS (SELECT 1 FROM subscription_connection_assignment_policies policy
        WHERE policy.connection_id = in_scope.connection_id
          AND policy.workspace_id = in_scope.workspace_id))) AS local
FROM in_scope
JOIN connection ON connection.id = in_scope.connection_id
JOIN source ON source.account_id = connection.account_id
  AND source.workspace_id = in_scope.workspace_id AND source.provider = connection.provider;

DO $one_owner$
DECLARE
  target record;
  used_ids uuid[];
  reach_ids uuid[];
  assigned_ids uuid[];
  local_ids uuid[];
  personal_used boolean;
  models_unrestricted boolean;
  policy_models text[];
  personal_any boolean;
  everywhere boolean;
  owner_workspace uuid;
BEGIN
  FOR target IN
    SELECT connection.id, connection.account_id, connection.provider, connection.scope_kind,
      connection.allow_personal_workspaces, connection.managed_by_workspace_id,
      connection.allocator_enabled
    FROM subscription_connections connection
    WHERE connection.ownership = 'shared' AND connection.disconnected_at IS NULL
      AND connection.scope_kind IN ('organization', 'workspaces')
    ORDER BY connection.id
  LOOP
    SELECT coalesce(array_agg(use.workspace_id ORDER BY use.workspace_id)
        FILTER (WHERE use.used), '{}'),
      coalesce(array_agg(use.workspace_id ORDER BY use.workspace_id)
        FILTER (WHERE use.assigned), '{}'),
      coalesce(array_agg(use.workspace_id ORDER BY use.workspace_id)
        FILTER (WHERE use.local), '{}'),
      coalesce(bool_and(use.used) FILTER (WHERE use.personal), true),
      coalesce(bool_or(use.personal), false),
      coalesce(bool_and(use.used), true)
    INTO used_ids, assigned_ids, local_ids, personal_used, personal_any, everywhere
    FROM subscription_one_owner_use use
    WHERE use.connection_id = target.id;

    -- A model list the admitting policies narrowed in every workspace that
    -- used the connection becomes the connection's own (their union, so no
    -- workspace loses a model it had). Policies never stored exclusions.
    SELECT coalesce(bool_or(policy.connection_id IS NULL OR policy.allowed_model_ids IS NULL), true),
      coalesce(array_agg(DISTINCT model.id ORDER BY model.id)
        FILTER (WHERE model.id IS NOT NULL), '{}')
    INTO models_unrestricted, policy_models
    FROM subscription_one_owner_use use
    LEFT JOIN subscription_connection_assignment_policies policy
      ON policy.connection_id = use.connection_id AND policy.workspace_id = use.workspace_id
        AND policy.allocator_enabled
        AND (use.inference_source = 'automatic' OR policy.inference_pool = use.inference_source)
    LEFT JOIN LATERAL unnest(policy.allowed_model_ids) AS model(id) ON true
    WHERE use.connection_id = target.id AND use.used;
    IF NOT models_unrestricted THEN
      UPDATE subscription_connections SET allowed_model_ids = CASE
          WHEN allowed_model_ids IS NULL THEN policy_models
          ELSE ARRAY(SELECT unnest(allowed_model_ids) INTERSECT SELECT unnest(policy_models)
            ORDER BY 1) END,
        access_version = access_version + 1, updated_at = clock_timestamp()
      WHERE id = target.id;
    END IF;

    -- 2. What it reaches: where it was used, or, used nowhere, where it is
    -- listed (switched off below).
    IF cardinality(used_ids) > 0 THEN
      reach_ids := used_ids;
    ELSE
      reach_ids := assigned_ids;
    END IF;

    -- 3. Its owner.
    owner_workspace := NULL;
    IF target.managed_by_workspace_id IS NOT NULL
        AND reach_ids <@ ARRAY[target.managed_by_workspace_id] THEN
      owner_workspace := target.managed_by_workspace_id;
    ELSIF target.managed_by_workspace_id IS NULL AND target.scope_kind = 'workspaces'
        AND cardinality(local_ids) = 1 AND reach_ids = local_ids
        AND NOT (target.allow_personal_workspaces AND personal_any) THEN
      owner_workspace := local_ids[1];
    END IF;

    IF owner_workspace IS NOT NULL THEN
      UPDATE subscription_connections SET managed_by_workspace_id = owner_workspace,
        scope_kind = 'workspaces', allow_personal_workspaces = false,
        allocator_enabled = allocator_enabled AND cardinality(used_ids) > 0,
        access_version = access_version + 1, updated_at = clock_timestamp()
      WHERE id = target.id;
      DELETE FROM subscription_connection_workspaces
      WHERE connection_id = target.id AND workspace_id <> ALL(reach_ids);
      IF cardinality(used_ids) > 0 THEN
        INSERT INTO subscription_connection_workspaces (account_id, connection_id, workspace_id)
        VALUES (target.account_id, target.id, owner_workspace)
        ON CONFLICT DO NOTHING;
      END IF;
      DELETE FROM opengeni_private.subscription_core_auto_assignments
      WHERE connection_id = target.id;
    ELSIF target.scope_kind = 'organization' THEN
      IF everywhere THEN
        CONTINUE;
      END IF;
      IF cardinality(used_ids) = 0 THEN
        -- Used nowhere: keep reaching everyone, switched off.
        UPDATE subscription_connections SET allocator_enabled = false,
          access_version = access_version + 1, updated_at = clock_timestamp()
        WHERE id = target.id AND allocator_enabled;
        CONTINUE;
      END IF;
      -- Every workspace that used it, still reaching shared workspaces
      -- created later (and Personal ones when every Personal one used it).
      UPDATE subscription_connections SET managed_by_workspace_id = NULL,
        scope_kind = 'workspaces', allow_personal_workspaces = personal_used,
        access_version = access_version + 1, updated_at = clock_timestamp()
      WHERE id = target.id;
      DELETE FROM subscription_connection_workspaces WHERE connection_id = target.id;
      INSERT INTO subscription_connection_workspaces (account_id, connection_id, workspace_id)
      SELECT target.account_id, target.id, use.workspace_id
      FROM subscription_one_owner_use use
      WHERE use.connection_id = target.id AND use.used AND NOT (use.personal AND personal_used);
      INSERT INTO opengeni_private.subscription_core_auto_assignments AS auto (
        account_id, provider, connection_id, shared_workspaces, personal_workspaces,
        allocator_enabled, allowed_model_ids
      )
      SELECT target.account_id, target.provider, target.id, true, personal_used,
        true, connection.allowed_model_ids
      FROM subscription_connections connection WHERE connection.id = target.id
      ON CONFLICT (connection_id) DO UPDATE SET shared_workspaces = true,
        personal_workspaces = excluded.personal_workspaces;
    ELSE
      -- Chosen workspaces, owned by the organization.
      IF target.managed_by_workspace_id IS NULL AND everywhere THEN
        CONTINUE;
      END IF;
      UPDATE subscription_connections SET managed_by_workspace_id = NULL,
        allow_personal_workspaces = allow_personal_workspaces
          AND (cardinality(used_ids) = 0 OR personal_used),
        allocator_enabled = allocator_enabled AND cardinality(used_ids) > 0,
        access_version = access_version + 1, updated_at = clock_timestamp()
      WHERE id = target.id;
      IF cardinality(used_ids) > 0 THEN
        DELETE FROM subscription_connection_workspaces
        WHERE connection_id = target.id AND workspace_id <> ALL(used_ids);
        IF target.allow_personal_workspaces AND NOT personal_used THEN
          INSERT INTO subscription_connection_workspaces (account_id, connection_id, workspace_id)
          SELECT target.account_id, target.id, use.workspace_id
          FROM subscription_one_owner_use use
          WHERE use.connection_id = target.id AND use.used AND use.personal
          ON CONFLICT DO NOTHING;
        END IF;
      END IF;
    END IF;
  END LOOP;
END
$one_owner$;

-- Only a connection serving chosen workspaces can be one workspace's own.
UPDATE subscription_connections SET managed_by_workspace_id = NULL,
  access_version = access_version + 1, updated_at = clock_timestamp()
WHERE managed_by_workspace_id IS NOT NULL
  AND (ownership <> 'shared' OR scope_kind <> 'workspaces');
UPDATE subscription_connections SET allow_personal_workspaces = false,
  access_version = access_version + 1, updated_at = clock_timestamp()
WHERE managed_by_workspace_id IS NOT NULL AND allow_personal_workspaces;

DELETE FROM subscription_connection_assignment_policies;

-- 5. The per-workspace preference is gone; an entry left empty is no
-- override at all.
UPDATE subscription_settings settings SET providers = coalesce((
    SELECT jsonb_object_agg(entry.key, entry.value - 'inferenceSource' - 'useOrganizationAccounts')
    FROM jsonb_each(settings.providers) entry
    WHERE entry.value - 'inferenceSource' - 'useOrganizationAccounts' <> '{}'::jsonb
  ), '{}'::jsonb)
WHERE EXISTS (SELECT 1 FROM jsonb_each(settings.providers) entry
  WHERE entry.value ? 'inferenceSource' OR entry.value ? 'useOrganizationAccounts');

-- A workspace's own connection reaches only that workspace.
ALTER TABLE subscription_connections
  ADD CONSTRAINT subscription_connections_workspace_owner_reach_chk CHECK (
    managed_by_workspace_id IS NULL
    OR (ownership = 'shared' AND scope_kind = 'workspaces' AND NOT allow_personal_workspaces));

-- ... and keeps it: a workspace's own connection is never assigned to
-- another workspace, and a connection reaching other workspaces cannot become
-- one workspace's own. Invoker rights: the writer already sees both rows.
DO $install_owner_reach$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.guard_subscription_workspace_owner_reach()
    RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    BEGIN
      IF TG_TABLE_NAME = 'subscription_connection_workspaces' THEN
        IF EXISTS (SELECT 1 FROM subscription_connections connection
            WHERE connection.account_id = NEW.account_id AND connection.id = NEW.connection_id
              AND connection.managed_by_workspace_id IS NOT NULL
              AND connection.managed_by_workspace_id <> NEW.workspace_id) THEN
          RAISE EXCEPTION 'a workspace''s own subscription connection serves only that workspace'
            USING ERRCODE = '23514';
        END IF;
      ELSIF NEW.managed_by_workspace_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM subscription_connection_workspaces assignment
          WHERE assignment.account_id = NEW.account_id AND assignment.connection_id = NEW.id
            AND assignment.workspace_id <> NEW.managed_by_workspace_id) THEN
        RAISE EXCEPTION 'a workspace''s own subscription connection serves only that workspace'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $body$
  $ddl$, data_schema);
END
$install_owner_reach$;
REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_workspace_owner_reach() FROM PUBLIC;
CREATE TRIGGER subscription_connection_workspaces_owner_reach
  BEFORE INSERT OR UPDATE ON subscription_connection_workspaces
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_workspace_owner_reach();
CREATE TRIGGER subscription_connections_owner_reach
  BEFORE UPDATE OF managed_by_workspace_id ON subscription_connections
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_workspace_owner_reach();

DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM subscription_connection_workspaces assignment
      JOIN subscription_connections connection ON connection.id = assignment.connection_id
      WHERE connection.managed_by_workspace_id IS NOT NULL
        AND assignment.workspace_id <> connection.managed_by_workspace_id) THEN
    RAISE EXCEPTION 'a workspace''s own subscription connection still reaches another workspace';
  END IF;
  IF EXISTS (SELECT 1 FROM subscription_connection_assignment_policies) THEN
    RAISE EXCEPTION 'subscription assignment policies remain';
  END IF;
END
$verify$;

-- New workspaces join an organization connection's reach by assignment
-- alone; the connection's own switch decides whether it serves.
DO $install$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_subscription_internal.apply_subscription_core_auto_assignments(
      p_provider text, p_account_id uuid, p_workspace_id uuid, p_personal boolean
    ) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM opengeni_private.subscription_core_auto_assignments auto
          WHERE auto.account_id = p_account_id AND auto.provider = p_provider) THEN
        RETURN;
      END IF;
      DELETE FROM subscription_connection_workspaces assignment
      USING opengeni_private.subscription_core_auto_assignments auto
      WHERE auto.account_id = p_account_id AND auto.provider = p_provider
        AND assignment.account_id = p_account_id
        AND assignment.connection_id = auto.connection_id AND assignment.workspace_id = p_workspace_id
        AND NOT (CASE WHEN p_personal THEN auto.personal_workspaces ELSE auto.shared_workspaces END);
      INSERT INTO subscription_connection_workspaces (account_id, connection_id, workspace_id)
      SELECT p_account_id, auto.connection_id, p_workspace_id
      FROM opengeni_private.subscription_core_auto_assignments auto
      WHERE auto.account_id = p_account_id AND auto.provider = p_provider
        AND CASE WHEN p_personal THEN auto.personal_workspaces ELSE auto.shared_workspaces END
        AND NOT EXISTS (SELECT 1 FROM subscription_connection_workspaces assignment
          WHERE assignment.account_id = p_account_id AND assignment.connection_id = auto.connection_id
            AND assignment.workspace_id = p_workspace_id);
    END
    $body$
  $ddl$, data_schema);
END
$install$;
REVOKE ALL ON FUNCTION opengeni_subscription_internal.apply_subscription_core_auto_assignments(
  text, uuid, uuid, boolean) FROM PUBLIC;

SELECT pg_catalog.set_config('opengeni.organization_tenancy_lifecycle', '', true);

ALTER TABLE subscription_connections ENABLE TRIGGER subscription_connections_scope_guard;
ALTER TABLE subscription_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_connection_workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_connection_assignment_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_settings FORCE ROW LEVEL SECURITY;
