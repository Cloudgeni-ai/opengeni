-- deployment-mode: maintenance
-- maintenance-justification: The fold holds ACCESS EXCLUSIVE on the four subscription tables until commit, measured at 6.1s for 30k connections with 100k workspaces on PostgreSQL 18, and serving clients would wait that long behind it; production counts are not yet known, so the release parks clients for it. An expand/contract split would need a binary that reads both the pool-row model and the one-owner model, which this release does not ship; shrinking this window is a follow-up.
-- online-safety-exception: maintenance-unbatched-data: every UPDATE, DELETE and INSERT here is one set-based statement over the subscription connection, reach, policy, auto-assignment and settings rows, never a per-connection loop; the whole migration measured 0.07s at 300 connections, 0.44s at 3k, 1.2s at 9k and 5.2s at 30k connections with 100k workspaces on PostgreSQL 18, growing linearly
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
--
-- Locks: this is a maintenance migration, so the production release parks
-- database clients before it runs. Each LOCK statement still waits at most 5s
-- in total, by statement_timeout (not 5s per table), for anything left
-- running. First SHARE ROW EXCLUSIVE on the five tables: it waits only for
-- writers and never blocks readers. Then ACCESS EXCLUSIVE on the four whose
-- row security the owner window relaxes (ALTER ... NO FORCE needs it anyway):
-- with writers already excluded it waits only for reads in progress, and
-- readers that arrive meanwhile queue behind it for at most those 5s. Once
-- granted, the locks are held until commit, for as long as the set-based fold
-- below takes (6.1s measured at 30k connections and 100k workspaces), and any
-- reader or writer still connected waits for that too. SHARE ROW EXCLUSIVE
-- then ACCESS EXCLUSIVE can exclude writers for two acquisitions (up to 5s
-- each) plus that hold. The workspace-owner CHECK added below is validated by
-- one scan under the same lock, under 40ms at 30k connections.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5s';
LOCK TABLE subscription_connections, subscription_connection_workspaces,
  subscription_connection_assignment_policies, subscription_settings,
  opengeni_private.subscription_core_auto_assignments
  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE subscription_connections, subscription_connection_workspaces,
  subscription_connection_assignment_policies, subscription_settings
  IN ACCESS EXCLUSIVE MODE;
SET LOCAL statement_timeout = '5min';

ALTER TABLE subscription_connections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_connection_workspaces NO FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_connection_assignment_policies NO FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_settings NO FORCE ROW LEVEL SECURITY;
-- The scope guard admits only organization administrators; this owner-only
-- backfill has no actor, so the guard is off inside this transaction alone.
ALTER TABLE subscription_connections DISABLE TRIGGER subscription_connections_scope_guard;

SELECT pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
  'organization_membership_lifecycle', true);

-- Every step below is one set-based statement over the whole chain, never a
-- per-connection or per-workspace loop, so its cost grows with the rows it
-- reads rather than with connections times workspaces.
--
-- The shared connections this folds, as they stood when the lock was taken.
CREATE TEMP TABLE subscription_one_owner_connection ON COMMIT DROP AS
SELECT connection.id, connection.account_id, connection.provider, connection.scope_kind,
  connection.allow_personal_workspaces, connection.managed_by_workspace_id
FROM subscription_connections connection
WHERE connection.ownership = 'shared' AND connection.disconnected_at IS NULL
  AND connection.scope_kind IN ('organization', 'workspaces');
CREATE UNIQUE INDEX ON subscription_one_owner_connection (id);
CREATE INDEX ON subscription_one_owner_connection (account_id);
ANALYZE subscription_one_owner_connection;

-- Every workspace of those organizations, and whether it is someone's Personal one.
CREATE TEMP TABLE subscription_one_owner_workspace ON COMMIT DROP AS
SELECT workspace.account_id, workspace.id, personal.workspace_id IS NOT NULL AS personal
FROM workspaces workspace
LEFT JOIN (SELECT DISTINCT membership.account_id, membership.personal_workspace_id AS workspace_id
    FROM organization_memberships membership
    WHERE membership.personal_workspace_id IS NOT NULL) personal
  ON personal.account_id = workspace.account_id AND personal.workspace_id = workspace.id
WHERE workspace.account_id IN (SELECT account_id FROM subscription_one_owner_connection);
CREATE UNIQUE INDEX ON subscription_one_owner_workspace (account_id, id);
ANALYZE subscription_one_owner_workspace;

-- The source each workspace used per provider: exactly the inferenceSource
-- subscription_effective_settings() reported (or the useOrganizationAccounts
-- it derived), computed in one join instead of one call per workspace. With
-- no organization settings row that function returns nothing: automatic.
CREATE TEMP TABLE subscription_one_owner_source ON COMMIT DROP AS
SELECT workspace.account_id, workspace.id AS workspace_id, provider.provider,
  CASE WHEN org.account_id IS NULL THEN 'automatic' ELSE coalesce(
    CASE
      WHEN entry.workspace_setting ? 'inferenceSource' THEN entry.workspace_setting->>'inferenceSource'
      WHEN entry.workspace_setting ? 'useOrganizationAccounts'
        THEN CASE WHEN entry.workspace_setting->>'useOrganizationAccounts' = 'false'
          THEN 'workspace' ELSE 'automatic' END
      WHEN entry.organization_setting ? 'inferenceSource'
        THEN entry.organization_setting->>'inferenceSource'
      WHEN entry.organization_setting ? 'useOrganizationAccounts'
        THEN CASE WHEN entry.organization_setting->>'useOrganizationAccounts' = 'false'
          THEN 'workspace' ELSE 'automatic' END
      ELSE 'automatic'
    END, 'automatic') END AS inference_source
FROM subscription_one_owner_workspace workspace
JOIN (SELECT DISTINCT account_id, provider FROM subscription_one_owner_connection) provider
  ON provider.account_id = workspace.account_id
LEFT JOIN subscription_settings org
  ON org.account_id = workspace.account_id AND org.workspace_id IS NULL
LEFT JOIN subscription_settings ws
  ON ws.account_id = workspace.account_id AND ws.workspace_id = workspace.id
CROSS JOIN LATERAL (SELECT
    coalesce(org.providers->provider.provider, '{}'::jsonb) AS organization_setting,
    CASE WHEN ws.providers ? provider.provider
      AND NOT ('providers' = ANY(coalesce(org.locked_settings, '{}')))
      THEN ws.providers->provider.provider ELSE '{}'::jsonb END AS workspace_setting) entry;
CREATE UNIQUE INDEX ON subscription_one_owner_source (account_id, workspace_id, provider);
ANALYZE subscription_one_owner_source;

-- The pool rows per connection and workspace.
CREATE TEMP TABLE subscription_one_owner_policy ON COMMIT DROP AS
SELECT policy.connection_id, policy.workspace_id,
  bool_or(policy.inference_pool = 'workspace') AS workspace_pool,
  coalesce(array_agg(DISTINCT policy.inference_pool) FILTER (WHERE policy.allocator_enabled),
    '{}') AS enabled_pools
FROM subscription_connection_assignment_policies policy
GROUP BY policy.connection_id, policy.workspace_id;
CREATE UNIQUE INDEX ON subscription_one_owner_policy (connection_id, workspace_id);
ANALYZE subscription_one_owner_policy;

-- 1. Where each connection is in scope, and whether it is used there.
CREATE TEMP TABLE subscription_one_owner_use ON COMMIT DROP AS
WITH in_scope AS (
  SELECT connection.id AS connection_id, workspace.id AS workspace_id, workspace.personal
  FROM subscription_one_owner_connection connection
  JOIN subscription_one_owner_workspace workspace ON workspace.account_id = connection.account_id
  WHERE connection.scope_kind = 'organization'
  UNION
  SELECT connection.id, workspace.id, workspace.personal
  FROM subscription_one_owner_connection connection
  JOIN subscription_connection_workspaces assignment
    ON assignment.account_id = connection.account_id AND assignment.connection_id = connection.id
  JOIN subscription_one_owner_workspace workspace
    ON workspace.account_id = connection.account_id AND workspace.id = assignment.workspace_id
  WHERE connection.scope_kind = 'workspaces'
  UNION
  SELECT connection.id, workspace.id, workspace.personal
  FROM subscription_one_owner_connection connection
  JOIN subscription_one_owner_workspace workspace
    ON workspace.account_id = connection.account_id AND workspace.personal
  WHERE connection.scope_kind = 'workspaces' AND connection.allow_personal_workspaces
)
SELECT in_scope.connection_id, in_scope.workspace_id, in_scope.personal,
  assignment.connection_id IS NOT NULL AS assigned, source.inference_source,
  CASE
    WHEN policy.connection_id IS NOT NULL
      THEN coalesce((source.inference_source = 'automatic' AND cardinality(policy.enabled_pools) > 0)
        OR source.inference_source = ANY(policy.enabled_pools), false)
    WHEN source.inference_source = 'workspace'
      THEN connection.managed_by_workspace_id IS NOT DISTINCT FROM in_scope.workspace_id
    WHEN source.inference_source = 'organization'
      THEN connection.managed_by_workspace_id IS DISTINCT FROM in_scope.workspace_id
    ELSE true
  END AS used,
  coalesce(policy.workspace_pool, false)
    OR (assignment.connection_id IS NOT NULL
      AND connection.managed_by_workspace_id IS NOT DISTINCT FROM in_scope.workspace_id
      AND policy.connection_id IS NULL) AS local
FROM in_scope
JOIN subscription_one_owner_connection connection ON connection.id = in_scope.connection_id
JOIN subscription_one_owner_source source ON source.account_id = connection.account_id
  AND source.workspace_id = in_scope.workspace_id AND source.provider = connection.provider
LEFT JOIN subscription_connection_workspaces assignment
  ON assignment.account_id = connection.account_id AND assignment.connection_id = connection.id
    AND assignment.workspace_id = in_scope.workspace_id
LEFT JOIN subscription_one_owner_policy policy
  ON policy.connection_id = in_scope.connection_id AND policy.workspace_id = in_scope.workspace_id;
CREATE UNIQUE INDEX ON subscription_one_owner_use (connection_id, workspace_id);
ANALYZE subscription_one_owner_use;

-- 2-4. Per connection: where it reaches, its owner, its model list and which
-- rewrite applies. A connection in scope nowhere keeps the defaults of an
-- empty aggregate (used nowhere, used everywhere it is in scope).
CREATE TEMP TABLE subscription_one_owner_plan ON COMMIT DROP AS
WITH aggregate AS (
  SELECT use.connection_id,
    array_agg(use.workspace_id ORDER BY use.workspace_id) FILTER (WHERE use.used) AS used_ids,
    array_agg(use.workspace_id ORDER BY use.workspace_id) FILTER (WHERE use.assigned) AS assigned_ids,
    array_agg(use.workspace_id ORDER BY use.workspace_id) FILTER (WHERE use.local) AS local_ids,
    bool_and(use.used) FILTER (WHERE use.personal) AS personal_used,
    bool_or(use.personal) AS personal_any,
    bool_and(use.used) AS everywhere
  FROM subscription_one_owner_use use
  GROUP BY use.connection_id
), models AS (
  -- A model list the admitting policies narrowed in every workspace that
  -- used the connection becomes the connection's own (their union, so no
  -- workspace loses a model it had). Policies never stored exclusions.
  SELECT use.connection_id,
    bool_or(policy.connection_id IS NULL OR policy.allowed_model_ids IS NULL) AS unrestricted,
    coalesce(array_agg(DISTINCT model.id ORDER BY model.id)
      FILTER (WHERE model.id IS NOT NULL), '{}') AS policy_models
  FROM subscription_one_owner_use use
  LEFT JOIN subscription_connection_assignment_policies policy
    ON policy.connection_id = use.connection_id AND policy.workspace_id = use.workspace_id
      AND policy.allocator_enabled
      AND (use.inference_source = 'automatic' OR policy.inference_pool = use.inference_source)
  LEFT JOIN LATERAL unnest(policy.allowed_model_ids) AS model(id) ON true
  WHERE use.used
  GROUP BY use.connection_id
), shaped AS (
  SELECT connection.*,
    coalesce(aggregate.used_ids, '{}') AS used_ids,
    coalesce(aggregate.assigned_ids, '{}') AS assigned_ids,
    coalesce(aggregate.local_ids, '{}') AS local_ids,
    coalesce(aggregate.personal_used, true) AS personal_used,
    coalesce(aggregate.personal_any, false) AS personal_any,
    coalesce(aggregate.everywhere, true) AS everywhere,
    coalesce(models.unrestricted, true) AS models_unrestricted,
    coalesce(models.policy_models, '{}') AS policy_models
  FROM subscription_one_owner_connection connection
  LEFT JOIN aggregate ON aggregate.connection_id = connection.id
  LEFT JOIN models ON models.connection_id = connection.id
), reached AS (
  -- 2. What it reaches: where it was used, or, used nowhere, where it is
  -- listed (switched off below).
  SELECT shaped.*,
    CASE WHEN cardinality(shaped.used_ids) > 0 THEN shaped.used_ids
      ELSE shaped.assigned_ids END AS reach_ids
  FROM shaped
), owned AS (
  -- 3. Its owner.
  SELECT reached.*,
    CASE
      WHEN reached.managed_by_workspace_id IS NOT NULL
        AND reached.reach_ids <@ ARRAY[reached.managed_by_workspace_id]
        THEN reached.managed_by_workspace_id
      WHEN reached.managed_by_workspace_id IS NULL AND reached.scope_kind = 'workspaces'
        AND cardinality(reached.local_ids) = 1 AND reached.reach_ids = reached.local_ids
        AND NOT (reached.allow_personal_workspaces AND reached.personal_any)
        THEN reached.local_ids[1]
    END AS owner_workspace
  FROM reached
)
SELECT owned.*,
  cardinality(owned.used_ids) > 0 AS used_somewhere,
  CASE
    WHEN owned.owner_workspace IS NOT NULL THEN 'owner'
    WHEN owned.scope_kind = 'organization' THEN CASE
      WHEN owned.everywhere THEN 'unchanged'
      WHEN cardinality(owned.used_ids) = 0 THEN 'switched_off'
      ELSE 'listed' END
    WHEN owned.managed_by_workspace_id IS NULL AND owned.everywhere THEN 'unchanged'
    ELSE 'chosen'
  END AS rewrite
FROM owned;
CREATE UNIQUE INDEX ON subscription_one_owner_plan (id);

-- 4. The narrowed model lists.
UPDATE subscription_connections connection SET allowed_model_ids = CASE
    WHEN connection.allowed_model_ids IS NULL THEN plan.policy_models
    ELSE ARRAY(SELECT unnest(connection.allowed_model_ids) INTERSECT SELECT unnest(plan.policy_models)
      ORDER BY 1) END,
  access_version = connection.access_version + 1, updated_at = clock_timestamp()
FROM subscription_one_owner_plan plan
WHERE connection.id = plan.id AND NOT plan.models_unrestricted;

-- One workspace's own: it reaches only that workspace.
UPDATE subscription_connections connection SET managed_by_workspace_id = plan.owner_workspace,
  scope_kind = 'workspaces', allow_personal_workspaces = false,
  allocator_enabled = connection.allocator_enabled AND plan.used_somewhere,
  access_version = connection.access_version + 1, updated_at = clock_timestamp()
FROM subscription_one_owner_plan plan
WHERE connection.id = plan.id AND plan.rewrite = 'owner';
DELETE FROM subscription_connection_workspaces assignment
USING subscription_one_owner_plan plan
WHERE plan.rewrite = 'owner' AND assignment.connection_id = plan.id
  AND assignment.workspace_id <> ALL(plan.reach_ids);
INSERT INTO subscription_connection_workspaces (account_id, connection_id, workspace_id)
SELECT plan.account_id, plan.id, plan.owner_workspace
FROM subscription_one_owner_plan plan
WHERE plan.rewrite = 'owner' AND plan.used_somewhere
ON CONFLICT DO NOTHING;
DELETE FROM opengeni_private.subscription_core_auto_assignments auto
USING subscription_one_owner_plan plan
WHERE plan.rewrite = 'owner' AND auto.connection_id = plan.id;

-- Organization-wide and used nowhere: keep reaching everyone, switched off.
UPDATE subscription_connections connection SET allocator_enabled = false,
  access_version = connection.access_version + 1, updated_at = clock_timestamp()
FROM subscription_one_owner_plan plan
WHERE connection.id = plan.id AND plan.rewrite = 'switched_off' AND connection.allocator_enabled;

-- Organization-wide but not used everywhere: every workspace that used it,
-- still reaching shared workspaces created later (and Personal ones when
-- every Personal one used it).
UPDATE subscription_connections connection SET managed_by_workspace_id = NULL,
  scope_kind = 'workspaces', allow_personal_workspaces = plan.personal_used,
  access_version = connection.access_version + 1, updated_at = clock_timestamp()
FROM subscription_one_owner_plan plan
WHERE connection.id = plan.id AND plan.rewrite = 'listed';
DELETE FROM subscription_connection_workspaces assignment
USING subscription_one_owner_plan plan
WHERE plan.rewrite = 'listed' AND assignment.connection_id = plan.id;
INSERT INTO subscription_connection_workspaces (account_id, connection_id, workspace_id)
SELECT plan.account_id, plan.id, use.workspace_id
FROM subscription_one_owner_plan plan
JOIN subscription_one_owner_use use ON use.connection_id = plan.id
WHERE plan.rewrite = 'listed' AND use.used AND NOT (use.personal AND plan.personal_used);
INSERT INTO opengeni_private.subscription_core_auto_assignments AS auto (
  account_id, provider, connection_id, shared_workspaces, personal_workspaces,
  allocator_enabled, allowed_model_ids
)
SELECT plan.account_id, plan.provider, plan.id, true, plan.personal_used,
  true, connection.allowed_model_ids
FROM subscription_one_owner_plan plan
JOIN subscription_connections connection ON connection.id = plan.id
WHERE plan.rewrite = 'listed'
ON CONFLICT (connection_id) DO UPDATE SET shared_workspaces = true,
  personal_workspaces = excluded.personal_workspaces;

-- Chosen workspaces, owned by the organization.
UPDATE subscription_connections connection SET managed_by_workspace_id = NULL,
  allow_personal_workspaces = connection.allow_personal_workspaces
    AND (NOT plan.used_somewhere OR plan.personal_used),
  allocator_enabled = connection.allocator_enabled AND plan.used_somewhere,
  access_version = connection.access_version + 1, updated_at = clock_timestamp()
FROM subscription_one_owner_plan plan
WHERE connection.id = plan.id AND plan.rewrite = 'chosen';
DELETE FROM subscription_connection_workspaces assignment
USING subscription_one_owner_plan plan
WHERE plan.rewrite = 'chosen' AND plan.used_somewhere AND assignment.connection_id = plan.id
  AND assignment.workspace_id <> ALL(plan.used_ids);
INSERT INTO subscription_connection_workspaces (account_id, connection_id, workspace_id)
SELECT plan.account_id, plan.id, use.workspace_id
FROM subscription_one_owner_plan plan
JOIN subscription_one_owner_use use ON use.connection_id = plan.id
WHERE plan.rewrite = 'chosen' AND plan.used_somewhere
  AND plan.allow_personal_workspaces AND NOT plan.personal_used
  AND use.used AND use.personal
ON CONFLICT DO NOTHING;

-- A disconnected connection serves nowhere and is folded nowhere above, but
-- it keeps its reach rows. One a workspace manages that still lists another
-- workspace becomes the organization's (as in 3), so the reach check below
-- holds instead of failing the migration.
UPDATE subscription_connections connection SET managed_by_workspace_id = NULL,
  access_version = connection.access_version + 1, updated_at = clock_timestamp()
WHERE connection.disconnected_at IS NOT NULL AND connection.managed_by_workspace_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM subscription_connection_workspaces assignment
    WHERE assignment.account_id = connection.account_id
      AND assignment.connection_id = connection.id
      AND assignment.workspace_id <> connection.managed_by_workspace_id);

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
--
-- The 0724 lock guard would check every stripped workspace row one at a
-- time. It can object to exactly one thing here: a provider entry that keeps
-- other values after the strip, in a workspace whose organization locks
-- `providers` (an entry left empty is removed, which only clears). That is
-- checked once for the whole table with the guard's own error, and the guard
-- is off for this one statement only. Where the guard is not installed there
-- is nothing to check, exactly as a row-by-row strip would find.
DO $locked_providers$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'subscription_settings'::regclass
        AND tgname = 'subscription_settings_locked_overrides_guard') THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM subscription_settings settings
      JOIN subscription_settings organization ON organization.account_id = settings.account_id
        AND organization.workspace_id IS NULL
      WHERE settings.workspace_id IS NOT NULL
        AND 'providers' = ANY(organization.locked_settings)
        AND EXISTS (SELECT 1 FROM jsonb_each(settings.providers) entry
          WHERE (entry.value ? 'inferenceSource' OR entry.value ? 'useOrganizationAccounts')
            AND entry.value - 'inferenceSource' - 'useOrganizationAccounts' <> '{}'::jsonb)) THEN
    RAISE EXCEPTION 'subscription setting % is locked by the organization', 'providers'
      USING ERRCODE = '42501', DETAIL = 'subscription_setting_locked:providers';
  END IF;
  ALTER TABLE subscription_settings DISABLE TRIGGER subscription_settings_locked_overrides_guard;
END
$locked_providers$;
UPDATE subscription_settings settings SET providers = coalesce((
    SELECT jsonb_object_agg(entry.key, entry.value - 'inferenceSource' - 'useOrganizationAccounts')
    FROM jsonb_each(settings.providers) entry
    WHERE entry.value - 'inferenceSource' - 'useOrganizationAccounts' <> '{}'::jsonb
  ), '{}'::jsonb)
WHERE EXISTS (SELECT 1 FROM jsonb_each(settings.providers) entry
  WHERE entry.value ? 'inferenceSource' OR entry.value ? 'useOrganizationAccounts');
DO $locked_providers_on$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'subscription_settings'::regclass
        AND tgname = 'subscription_settings_locked_overrides_guard') THEN
    ALTER TABLE subscription_settings ENABLE TRIGGER subscription_settings_locked_overrides_guard;
  END IF;
END
$locked_providers_on$;

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
