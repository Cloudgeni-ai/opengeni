-- deployment-mode: rolling
-- A workspace membership administers its workspace when its role is "owner"
-- or "admin", or its permissions include workspace:admin. That is what the API
-- checks (workspace:admin) and what usage allowances already accept (0552).
-- The subscription and vault rules instead required the literal role
-- "admin", so a configured deployment's own subject, whose membership is
-- created as "owner" with full workspace permissions, passed the API check and
-- was then refused by the database when it connected or managed a workspace's
-- subscription account.
--
-- 1. workspace_membership_administers(role, permissions): the one predicate.
-- 2. Every routine and row policy that tested a workspace membership's role
--    for 'admin' now calls it. Routines are rewritten from pg_get_functiondef,
--    so owner, ACL, SECURITY DEFINER, search_path and every other predicate
--    are preserved; policies keep their exact expressions apart from that
--    test. Organization-membership role checks are unchanged.
-- Routine bodies and policy expressions only: no table rewrite or long lock.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION opengeni_private.workspace_membership_administers(
  p_role text,
  p_permissions jsonb
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT p_role IN ('owner', 'admin')
    OR coalesce(pg_catalog.jsonb_typeof(p_permissions) = 'array'
      AND p_permissions ? 'workspace:admin', false)
$function$;

DO $routines$
DECLARE
  target regprocedure;
  definition text;
  rewritten text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'opengeni_private.disconnect_subscription_core_connection(text,uuid,uuid,text,uuid)'::regprocedure,
    'opengeni_private.guard_subscription_connection_scope()'::regprocedure,
    'opengeni_private.subscription_apps_designation_allowed(uuid,uuid,uuid)'::regprocedure,
    'opengeni_private.subscription_apps_designation_manage_allowed(uuid,uuid,uuid)'::regprocedure,
    'opengeni_private.subscription_codex_reset_authority(uuid,uuid,uuid,text)'::regprocedure,
    'opengeni_private.vault_subject_has_secrets_use(uuid,uuid,text)'::regprocedure
  ] LOOP
    definition := pg_catalog.pg_get_functiondef(target);
    rewritten := pg_catalog.regexp_replace(
      definition,
      '\m(manager|workspace_membership)\.role\s*=\s*''admin''',
      'opengeni_private.workspace_membership_administers(\1.role, \1.permissions)',
      'g'
    );
    IF rewritten = definition THEN
      IF pg_catalog.strpos(definition, 'workspace_membership_administers(') > 0 THEN
        CONTINUE;
      END IF;
      RAISE EXCEPTION 'workspace administrator source contract changed in %', target
        USING ERRCODE = '55000';
    END IF;
    EXECUTE rewritten;
  END LOOP;
END
$routines$;

DO $policies$
DECLARE
  policy record;
  using_expression text;
  check_expression text;
  pattern constant text := '\(?\m(grant_row|manager)\.role = ''admin''::text\)?';
  replacement constant text :=
    'opengeni_private.workspace_membership_administers(\1.role, \1.permissions)';
  changed integer := 0;
BEGIN
  FOR policy IN
    SELECT policies.tablename, policies.policyname, policies.qual, policies.with_check
    FROM pg_catalog.pg_policies policies
    WHERE policies.schemaname = pg_catalog.current_schema()
      AND (policies.tablename, policies.policyname) IN (
        ('subscription_connection_assignment_policies',
          'subscription_connection_assignment_policy_manage'),
        ('subscription_connections', 'subscription_connections_insert_workspace_admin'),
        ('subscription_connections', 'subscription_connections_update_scope'),
        ('subscription_settings', 'subscription_settings_manager')
      )
  LOOP
    using_expression := pg_catalog.regexp_replace(policy.qual, pattern, replacement, 'g');
    check_expression := pg_catalog.regexp_replace(policy.with_check, pattern, replacement, 'g');
    IF using_expression IS NOT DISTINCT FROM policy.qual
      AND check_expression IS NOT DISTINCT FROM policy.with_check
    THEN
      IF pg_catalog.strpos(
        coalesce(policy.qual, '') || coalesce(policy.with_check, ''),
        'workspace_membership_administers('
      ) > 0 THEN
        changed := changed + 1;
        CONTINUE;
      END IF;
      RAISE EXCEPTION 'workspace administrator policy contract changed in %.%',
        policy.tablename, policy.policyname USING ERRCODE = '55000';
    END IF;
    IF using_expression IS NOT NULL THEN
      EXECUTE pg_catalog.format('ALTER POLICY %I ON %I USING (%s)',
        policy.policyname, policy.tablename, using_expression);
    END IF;
    IF check_expression IS NOT NULL THEN
      EXECUTE pg_catalog.format('ALTER POLICY %I ON %I WITH CHECK (%s)',
        policy.policyname, policy.tablename, check_expression);
    END IF;
    changed := changed + 1;
  END LOOP;
  IF changed <> 4 THEN
    RAISE EXCEPTION 'expected 4 workspace administrator policies, found %', changed
      USING ERRCODE = '55000';
  END IF;
END
$policies$;
