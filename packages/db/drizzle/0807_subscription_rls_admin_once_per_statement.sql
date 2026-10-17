-- deployment-mode: rolling
-- Two cost fixes for subscription authorization, with unchanged outcomes.
--
-- 1. Organization-admin policies ran once per row.
--    Policies on the subscription tables call
--    opengeni_private.subscription_organization_admin(account_id) per row.
--    That SECURITY DEFINER PL/pgSQL helper writes and deletes a runtime
--    capability row and probes organization_memberships on every call, so
--    listing a few dozen connection rows cost a few dozen capability writes.
--    The helper only ever answers true for the tenant in
--    opengeni.account_id, so each policy now compares the row's account with
--    that setting (exactly as the helper does, as text) and asks the helper
--    once per statement through an uncorrelated subquery (an InitPlan).
--
-- 2. Runtime capability rows leaked.
--    Turn-scoped grants (session_access and similar) intentionally live until
--    their transaction ends, and nothing removed them afterwards, so
--    opengeni_private.subscription_runtime_capabilities grew by one row per
--    accepted turn access. Every check is keyed by (backend_pid,
--    transaction_id) of the current transaction, so a row from an earlier
--    transaction can never authorize anything again. Each insert now first
--    removes its own backend's rows from earlier transactions (a backend runs
--    one transaction at a time, and xid8 values never repeat), which bounds
--    the table by the number of live backends. Existing rows of finished
--    transactions are purged once here.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- Purge first: this only takes a ROW EXCLUSIVE lock, so live grants keep
-- inserting while it runs. The trigger and policy changes below take
-- stronger locks, which are then held only for the short rest of the
-- transaction. Every transaction older than this snapshot's xmin has
-- finished.
DELETE FROM opengeni_private.subscription_runtime_capabilities
WHERE transaction_id < pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot());

CREATE FUNCTION opengeni_private.reclaim_finished_subscription_runtime_capabilities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  DELETE FROM opengeni_private.subscription_runtime_capabilities finished
  WHERE finished.backend_pid = NEW.backend_pid
    AND finished.transaction_id < NEW.transaction_id;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.reclaim_finished_subscription_runtime_capabilities() FROM PUBLIC;

CREATE TRIGGER subscription_runtime_capabilities_reclaim_finished
  BEFORE INSERT ON opengeni_private.subscription_runtime_capabilities
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.reclaim_finished_subscription_runtime_capabilities();

DO $subscription_admin_policies$
DECLARE
  data_schema text := current_schema();
  policy record;
  -- Dedicated-schema installs migrate with opengeni_private on search_path,
  -- where pg_get_expr prints the helper without its schema prefix.
  call_pattern text :=
    '(?:opengeni_private\.)?subscription_organization_admin\(((?:(?:"[^"]+"|[a-z_][a-z0-9_]*)\.)?account_id)\)';
  replacement text :=
    '(((\1)::text = NULLIF(pg_catalog.current_setting(''opengeni.account_id'', true), ''''))'
    || ' AND COALESCE((SELECT opengeni_private.subscription_organization_admin(admin_scope.account_setting::uuid)'
    || ' FROM (SELECT NULLIF(pg_catalog.current_setting(''opengeni.account_id'', true), '''') AS account_setting) admin_scope'
    || ' WHERE admin_scope.account_setting ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''), false))';
  new_qual text;
  new_check text;
  rewritten integer := 0;
BEGIN
  FOR policy IN
    SELECT
      p.polname,
      c.relname,
      pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS qual,
      pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
    FROM pg_catalog.pg_policy p
    JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = data_schema
      AND (
        pg_catalog.pg_get_expr(p.polqual, p.polrelid) LIKE '%subscription_organization_admin(%'
        OR pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%subscription_organization_admin(%'
      )
    ORDER BY c.relname, p.polname
  LOOP
    new_qual := CASE WHEN policy.qual IS NULL THEN NULL
      ELSE pg_catalog.regexp_replace(policy.qual, call_pattern, replacement, 'g') END;
    new_check := CASE WHEN policy.check_expr IS NULL THEN NULL
      ELSE pg_catalog.regexp_replace(policy.check_expr, call_pattern, replacement, 'g') END;
    -- Only the per-row call may remain as the once-per-statement subquery.
    IF pg_catalog.regexp_replace(coalesce(new_qual, '') || coalesce(new_check, ''),
        'opengeni_private\.subscription_organization_admin\(admin_scope\.account_setting::uuid\)', '', 'g')
      LIKE '%subscription_organization_admin(%' THEN
      RAISE EXCEPTION 'Unrecognised subscription_organization_admin call in policy % on %',
        policy.polname, policy.relname
        USING ERRCODE = '55000';
    END IF;
    IF new_qual IS NOT NULL AND new_check IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'ALTER POLICY %I ON %I.%I USING (%s) WITH CHECK (%s)',
        policy.polname, data_schema, policy.relname, new_qual, new_check
      );
    ELSIF new_qual IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'ALTER POLICY %I ON %I.%I USING (%s)',
        policy.polname, data_schema, policy.relname, new_qual
      );
    ELSE
      EXECUTE pg_catalog.format(
        'ALTER POLICY %I ON %I.%I WITH CHECK (%s)',
        policy.polname, data_schema, policy.relname, new_check
      );
    END IF;
    rewritten := rewritten + 1;
  END LOOP;
  RAISE NOTICE 'subscription admin policies evaluated once per statement: %', rewritten;
END
$subscription_admin_policies$;
