-- deployment-mode: rolling
-- Organization settings locks for the shared subscription core (design
-- docs/design/subscription-core-2026-10-07.md, 3.3 and "M5: settings with
-- overrides and the overview"; contract SUB-SET-01..05).
--
-- `subscription_settings` already holds one organization row (every value
-- set, `locked_settings`) and optional workspace rows (NULL = inherit), and
-- `subscription_effective_settings` already ignores a workspace override of a
-- locked setting. This migration makes a lock enforceable at write time and
-- keeps stored data consistent with it. It changes no column, no existing
-- routine and no existing value, so the effective settings of every
-- workspace are the same before and after it.
--
-- 1. CHECKs: `locked_settings` names only the six setting keys, and
--    `fallback_order` maps each preferred model to an array of model ids.
--    Both are added NOT VALID and validated in place (no rewrite).
-- 2. Workspace-row guard (BEFORE INSERT OR UPDATE): a write that sets or
--    changes a setting the organization row locks is refused with 42501,
--    whoever writes it (workspace administrators, organization
--    administrators, and the owner-run core routines alike). Clearing an
--    override, or leaving it unchanged, is always allowed (an upsert is
--    judged on its proposed row, so `INSERT ... ON CONFLICT` carrying a
--    locked value is refused even when the stored row already has it). A
--    rotation lock
--    also covers every `*_primary_connection_id` column, found by name so a
--    renamed or added provider column is covered without a migration. The
--    guard is SECURITY DEFINER so a caller that cannot see the organization
--    row cannot mistake it for an absent one; it reads that row through an
--    owner-only policy that admits only the guard's own owner while the
--    guard names the row's organization in a transaction-local setting.
--    A write that widens any setting must run at READ COMMITTED (0A000,
--    `subscription_settings_requires_read_committed`, otherwise): an older
--    snapshot could miss a lock committed after it was taken.
-- 3. Organization-row lock writer (AFTER INSERT OR UPDATE OF
--    locked_settings): newly locked settings are cleared from every
--    workspace row of that organization in the same transaction (a lock is
--    never a dormant override that resurfaces when it is lifted). It is
--    SECURITY INVOKER: it clears what the locking administrator may write.
--    A rotation lock clears the rotation map only; a workspace primary
--    column is inert without a workspace rotation entry. It also runs only
--    at READ COMMITTED, so the clear sees every committed workspace row.
-- 4. Serialization: the guard takes a shared transaction advisory lock on
--    `subscription-settings-locks:<organization>` and the lock writer an
--    exclusive one, so a workspace write either commits before the lock
--    writer clears overrides or sees the new lock. An upsert's guard takes
--    the shared lock before it meets (and waits for) an existing row, so a
--    lock writer holding that row must not wait for the exclusive lock: it
--    only tries, and raises 55P03 (`subscription_settings_lock_busy`) while
--    any workspace write is in flight. Holding the exclusive lock, it locks
--    the rows it clears with NOWAIT and raises the same 55P03 if another
--    writer holds one (that writer may be waiting for this lock). It never
--    waits while holding the exclusive lock, so it cannot deadlock with a
--    workspace writer; it yields and its caller retries the whole
--    transaction. The repository takes the same advisory lock itself, before
--    any row lock: workspace writers take it shared, and a lock change
--    queues for it exclusively (bounded by a lock timeout), so widening
--    writes that arrive later wait behind the change instead of starving it,
--    and the trigger's try finds the lock already held.
-- 5. Identity: a settings row never changes its organization or workspace
--    (42501, `subscription_settings_identity_immutable`), so neither a moved
--    workspace row nor a converted organization row can carry a value past
--    the guard.
SET LOCAL lock_timeout = '5s';

-- 1. Stored-shape checks.
ALTER TABLE subscription_settings
  ADD CONSTRAINT subscription_settings_locked_keys_chk CHECK (
    locked_settings <@ ARRAY['rotation', 'providers', 'crossProviderFailover', 'fallbackOrder',
      'personalConnectionsAllowed', 'personalFallbackAllowed']::text[]
  ) NOT VALID,
  ADD CONSTRAINT subscription_settings_fallback_order_shape_chk CHECK (
    fallback_order IS NULL OR (
      -- strict: lax mode would unwrap each array before the filter. silent:
      -- a non-array value fails the first test rather than raising.
      NOT jsonb_path_exists(fallback_order, 'strict $.* ? (@.type() != "array")', '{}', true)
      AND NOT jsonb_path_exists(fallback_order, 'strict $.*[*] ? (@.type() != "string")', '{}', true)
    )
  ) NOT VALID;
ALTER TABLE subscription_settings VALIDATE CONSTRAINT subscription_settings_locked_keys_chk;
ALTER TABLE subscription_settings VALIDATE CONSTRAINT subscription_settings_fallback_order_shape_chk;

-- 2. The workspace-row guard.
CREATE FUNCTION opengeni_private.subscription_setting_override_widened(
  p_new jsonb, p_old jsonb, p_keyed boolean
) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $body$
  -- A value widens an override unless it is absent (SQL or JSON null) or,
  -- for a map, every entry it has is already stored unchanged.
  SELECT CASE
    WHEN p_new IS NULL OR pg_catalog.jsonb_typeof(p_new) = 'null' THEN false
    WHEN NOT p_keyed THEN p_new IS DISTINCT FROM p_old
    WHEN pg_catalog.jsonb_typeof(p_new) <> 'object' THEN true
    ELSE EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_each(p_new) entry
      WHERE p_old IS NULL OR pg_catalog.jsonb_typeof(p_old) <> 'object'
        OR NOT (p_old ? entry.key) OR (p_old -> entry.key) IS DISTINCT FROM entry.value
    )
  END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.subscription_setting_override_widened(jsonb,jsonb,boolean) FROM PUBLIC;

CREATE FUNCTION opengeni_private.guard_subscription_settings_locked_overrides()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  locked text[];
  new_row jsonb;
  old_row jsonb;
  setting text;
  column_name text;
  keyed boolean;
BEGIN
  IF NEW.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;
  new_row := pg_catalog.to_jsonb(NEW);
  old_row := CASE WHEN TG_OP = 'UPDATE' THEN pg_catalog.to_jsonb(OLD) ELSE '{}'::jsonb END;
  -- A write that only clears or keeps values needs no lock check (and no
  -- advisory lock): clearing an override is always allowed.
  IF NOT EXISTS (
      SELECT 1 FROM (VALUES ('rotation', true), ('providers', true), ('fallback_order', true),
          ('cross_provider_failover', false), ('personal_connections_allowed', false),
          ('personal_fallback_allowed', false)) setting_column(name, keyed)
      WHERE opengeni_private.subscription_setting_override_widened(
        new_row -> setting_column.name, old_row -> setting_column.name, setting_column.keyed))
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_object_keys(new_row) entry(key)
      WHERE entry.key LIKE '%\_primary\_connection\_id'
        AND opengeni_private.subscription_setting_override_widened(
          new_row -> entry.key, old_row -> entry.key, false)) THEN
    RETURN NEW;
  END IF;
  -- READ UNCOMMITTED runs as READ COMMITTED in PostgreSQL.
  IF pg_catalog.current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION 'subscription settings overrides are written at READ COMMITTED only'
      USING ERRCODE = '0A000', DETAIL = 'subscription_settings_requires_read_committed';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(
    'subscription-settings-locks:' || NEW.account_id::text, 0));
  PERFORM pg_catalog.set_config('opengeni.subscription_settings_lock_probe', NEW.account_id::text, true);
  SELECT organization.locked_settings INTO locked
  FROM subscription_settings organization
  WHERE organization.account_id = NEW.account_id AND organization.workspace_id IS NULL;
  PERFORM pg_catalog.set_config('opengeni.subscription_settings_lock_probe', '', true);
  IF locked IS NULL OR pg_catalog.cardinality(locked) = 0 THEN
    RETURN NEW;
  END IF;
  FOREACH setting IN ARRAY locked LOOP
    column_name := CASE setting
      WHEN 'rotation' THEN 'rotation'
      WHEN 'providers' THEN 'providers'
      WHEN 'fallbackOrder' THEN 'fallback_order'
      WHEN 'crossProviderFailover' THEN 'cross_provider_failover'
      WHEN 'personalConnectionsAllowed' THEN 'personal_connections_allowed'
      WHEN 'personalFallbackAllowed' THEN 'personal_fallback_allowed'
    END;
    IF column_name IS NULL THEN
      RAISE EXCEPTION 'unknown subscription setting lock' USING ERRCODE = '22023';
    END IF;
    keyed := setting IN ('rotation', 'providers', 'fallbackOrder');
    IF opengeni_private.subscription_setting_override_widened(
        new_row -> column_name, old_row -> column_name, keyed) THEN
      RAISE EXCEPTION 'subscription setting % is locked by the organization', setting
        USING ERRCODE = '42501', DETAIL = 'subscription_setting_locked:' || setting;
    END IF;
    IF setting = 'rotation' THEN
      FOR column_name IN
        SELECT entry.key FROM pg_catalog.jsonb_object_keys(new_row) entry(key)
        WHERE entry.key LIKE '%\_primary\_connection\_id'
      LOOP
        IF opengeni_private.subscription_setting_override_widened(
            new_row -> column_name, old_row -> column_name, false) THEN
          RAISE EXCEPTION 'subscription setting rotation is locked by the organization'
            USING ERRCODE = '42501', DETAIL = 'subscription_setting_locked:rotation';
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_settings_locked_overrides() FROM PUBLIC;

-- The guard reads the organization row as its owner. Admit exactly that:
-- the guard's owner, an organization row, and the organization the guard
-- named for the current statement. Invariant: every owner-run routine pins
-- its account to the caller's `opengeni.account_id` scope, so a caller that
-- sets the probe itself before calling one gains no organization row that
-- the ordinary `subscription_settings_scope` policy does not already admit.
CREATE POLICY subscription_settings_lock_guard_read ON subscription_settings FOR SELECT
  USING (workspace_id IS NULL
    AND current_user = pg_catalog.pg_get_userbyid((SELECT proc.proowner FROM pg_catalog.pg_proc proc
      WHERE proc.oid = 'opengeni_private.guard_subscription_settings_locked_overrides()'::regprocedure))
    AND account_id::text = nullif(current_setting('opengeni.subscription_settings_lock_probe', true), ''));

CREATE TRIGGER subscription_settings_locked_overrides_guard
  BEFORE INSERT OR UPDATE ON subscription_settings
  FOR EACH ROW WHEN (NEW.workspace_id IS NOT NULL)
  EXECUTE FUNCTION opengeni_private.guard_subscription_settings_locked_overrides();

-- 3. The organization-row lock writer.
CREATE FUNCTION opengeni_private.clear_subscription_settings_locked_overrides()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $body$
DECLARE
  added text[];
BEGIN
  IF NEW.workspace_id IS NOT NULL THEN
    RETURN NULL;
  END IF;
  added := ARRAY(
    SELECT setting FROM pg_catalog.unnest(NEW.locked_settings) setting
    EXCEPT
    SELECT setting FROM pg_catalog.unnest(
      CASE WHEN TG_OP = 'UPDATE' THEN OLD.locked_settings ELSE '{}'::text[] END) setting
  );
  IF pg_catalog.cardinality(added) = 0 THEN
    RETURN NULL;
  END IF;
  -- READ UNCOMMITTED runs as READ COMMITTED in PostgreSQL.
  IF pg_catalog.current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION 'subscription settings locks are written at READ COMMITTED only'
      USING ERRCODE = '0A000', DETAIL = 'subscription_settings_requires_read_committed';
  END IF;
  -- Try, never wait: an upsert holding the shared lock may be waiting for a
  -- workspace row this transaction holds (see 4. above).
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
      'subscription-settings-locks:' || NEW.account_id::text, 0)) THEN
    RAISE EXCEPTION 'a workspace settings write is in flight; retry the lock change'
      USING ERRCODE = '55P03', DETAIL = 'subscription_settings_lock_busy';
  END IF;
  -- Holding the exclusive lock, never wait for a row either: a writer that
  -- locked a row it is about to widen waits for this lock (see 4. above).
  BEGIN
    PERFORM 1 FROM subscription_settings workspace_row
    WHERE workspace_row.account_id = NEW.account_id
      AND workspace_row.workspace_id IS NOT NULL
      AND (('rotation' = ANY(added) AND workspace_row.rotation IS NOT NULL)
        OR ('providers' = ANY(added) AND workspace_row.providers IS NOT NULL)
        OR ('fallbackOrder' = ANY(added) AND workspace_row.fallback_order IS NOT NULL)
        OR ('crossProviderFailover' = ANY(added) AND workspace_row.cross_provider_failover IS NOT NULL)
        OR ('personalConnectionsAllowed' = ANY(added)
          AND workspace_row.personal_connections_allowed IS NOT NULL)
        OR ('personalFallbackAllowed' = ANY(added)
          AND workspace_row.personal_fallback_allowed IS NOT NULL))
    FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'a workspace settings write is in flight; retry the lock change'
      USING ERRCODE = '55P03', DETAIL = 'subscription_settings_lock_busy';
  END;
  UPDATE subscription_settings workspace_row SET
    rotation = CASE WHEN 'rotation' = ANY(added) THEN NULL ELSE workspace_row.rotation END,
    providers = CASE WHEN 'providers' = ANY(added) THEN NULL ELSE workspace_row.providers END,
    fallback_order = CASE WHEN 'fallbackOrder' = ANY(added) THEN NULL ELSE workspace_row.fallback_order END,
    cross_provider_failover = CASE WHEN 'crossProviderFailover' = ANY(added)
      THEN NULL ELSE workspace_row.cross_provider_failover END,
    personal_connections_allowed = CASE WHEN 'personalConnectionsAllowed' = ANY(added)
      THEN NULL ELSE workspace_row.personal_connections_allowed END,
    personal_fallback_allowed = CASE WHEN 'personalFallbackAllowed' = ANY(added)
      THEN NULL ELSE workspace_row.personal_fallback_allowed END,
    version = workspace_row.version + 1,
    updated_by_subject_id = NEW.updated_by_subject_id,
    updated_at = pg_catalog.clock_timestamp()
  WHERE workspace_row.account_id = NEW.account_id
    AND workspace_row.workspace_id IS NOT NULL
    AND (('rotation' = ANY(added) AND workspace_row.rotation IS NOT NULL)
      OR ('providers' = ANY(added) AND workspace_row.providers IS NOT NULL)
      OR ('fallbackOrder' = ANY(added) AND workspace_row.fallback_order IS NOT NULL)
      OR ('crossProviderFailover' = ANY(added) AND workspace_row.cross_provider_failover IS NOT NULL)
      OR ('personalConnectionsAllowed' = ANY(added)
        AND workspace_row.personal_connections_allowed IS NOT NULL)
      OR ('personalFallbackAllowed' = ANY(added)
        AND workspace_row.personal_fallback_allowed IS NOT NULL));
  RETURN NULL;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.clear_subscription_settings_locked_overrides() FROM PUBLIC;

CREATE TRIGGER subscription_settings_locked_overrides_clear
  AFTER INSERT OR UPDATE OF locked_settings ON subscription_settings
  FOR EACH ROW WHEN (NEW.workspace_id IS NULL)
  EXECUTE FUNCTION opengeni_private.clear_subscription_settings_locked_overrides();

-- 5. Identity: a row keeps its organization and workspace.
CREATE FUNCTION opengeni_private.guard_subscription_settings_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'a subscription settings row cannot move to another organization or workspace'
      USING ERRCODE = '42501', DETAIL = 'subscription_settings_identity_immutable';
  END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_settings_identity() FROM PUBLIC;

CREATE TRIGGER subscription_settings_identity_immutable
  BEFORE UPDATE OF account_id, workspace_id ON subscription_settings
  FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.guard_subscription_settings_identity();

-- Pin both trigger functions to the data schema with pg_temp last, so a
-- session's temporary table cannot shadow subscription_settings.
DO $subscription_settings_locks_search_path$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.guard_subscription_settings_locked_overrides() SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema);
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.clear_subscription_settings_locked_overrides() SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema);
END
$subscription_settings_locks_search_path$;

-- Every configured application role (not only the default name) holds
-- EXECUTE before provision-roles, so an older binary's posture check stays
-- clean (0715's pattern). The three trigger functions cannot be called
-- directly, and the comparison helper is a pure function.
DO $grant_runtime$
DECLARE
  application_role text;
BEGIN
  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
    UNION SELECT 'opengeni_app'
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.subscription_setting_override_widened(jsonb,jsonb,boolean) TO %I',
      application_role);
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.guard_subscription_settings_locked_overrides() TO %I',
      application_role);
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.clear_subscription_settings_locked_overrides() TO %I',
      application_role);
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.guard_subscription_settings_identity() TO %I',
      application_role);
  END LOOP;
END
$grant_runtime$;
