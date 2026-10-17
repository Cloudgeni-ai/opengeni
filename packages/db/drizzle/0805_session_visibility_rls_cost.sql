-- deployment-mode: rolling
-- Make session visibility row-level security cost proportional to the rows a
-- query actually returns, without changing who can see what.
--
-- Every session child table (events, history items, turns, content blobs and
-- ~90 others) carries a restrictive policy that calls
-- session_reference_visible(account_id, workspace_id, session_id) per row.
-- That SQL function cannot be inlined (its body has a sublink and it pins
-- search_path), so PostgreSQL started a fresh function executor, pushed and
-- popped the GUC stack, and re-planned its InitPlans for every row. Inside it,
-- the sessions policies then called several SECURITY DEFINER PL/pgSQL helpers
-- per probe, and for private sessions one helper opened a subtransaction per
-- row. Reading a few thousand events cost 100-400 microseconds per row.
--
-- This migration keeps every policy's truth table and only changes how it is
-- evaluated:
--
-- 1. Child policies inline the same EXISTS probe of sessions that the helper
--    ran, so it executes as an ordinary per-row subplan of the query.
-- 2. Each sessions policy gains a constant-cost first disjunct that is already
--    implied by the installed predicate (no subject, workspace-shared, no Site
--    access root, current writer protocol), so the expensive helpers run only
--    when the cheap answer is not already true.
-- 3. A private session owned by the acting human is recognised against an
--    array of that human's qualifying memberships computed once per statement
--    (an InitPlan) instead of one SECURITY DEFINER call and subtransaction per
--    row. The per-row helper still decides every other case, and is skipped
--    for sessions neither the actor nor the initiating human owns, where it
--    always returned false.
--
-- session_reference_visible stays installed and granted for the routines and
-- callers that use it directly.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $session_private_actor_visible_keys$
DECLARE
  data_schema text := current_schema();
  role_name text;
BEGIN
  IF pg_catalog.to_regprocedure(
    pg_catalog.format('%I.session_private_actor_visible(uuid,uuid,uuid,text)', data_schema)
  ) IS NULL THEN
    RAISE EXCEPTION 'session visibility helper chain is missing'
      USING ERRCODE = '42883';
  END IF;
  -- Same membership predicate and lifecycle marker as
  -- session_private_actor_visible, evaluated for the current tenant and both
  -- acting subjects at once. Keys are membership_id:subject_id pairs.
  EXECUTE pg_catalog.format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.session_private_actor_visible_keys()
    RETURNS text[]
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      actor_subject_id text := nullif(
        pg_catalog.current_setting('opengeni.subject_id', true), ''
      );
      initiating_human_subject_id text := nullif(
        pg_catalog.current_setting('opengeni.initiating_human_subject_id', true), ''
      );
      current_account_id uuid := nullif(
        pg_catalog.current_setting('opengeni.account_id', true), ''
      )::uuid;
      current_workspace_id uuid := nullif(
        pg_catalog.current_setting('opengeni.workspace_id', true), ''
      )::uuid;
      previous_lifecycle_marker text := pg_catalog.current_setting(
        'opengeni.organization_tenancy_lifecycle', true
      );
      keys text[];
    BEGIN
      IF current_account_id IS NULL
        OR current_workspace_id IS NULL
        OR (actor_subject_id IS NULL AND initiating_human_subject_id IS NULL)
      THEN
        RETURN '{}'::text[];
      END IF;
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        'session_visibility_activation',
        true
      );
      SELECT coalesce(
        pg_catalog.array_agg(membership.id::text || ':' || membership.subject_id),
        '{}'::text[]
      )
      INTO keys
      FROM organization_memberships membership
      WHERE membership.account_id = current_account_id
        AND membership.subject_id IN (actor_subject_id, initiating_human_subject_id)
        AND membership.status = 'active'
        AND (
          membership.personal_workspace_id = current_workspace_id
          OR EXISTS (
            SELECT 1
            FROM workspace_memberships workspace_membership
            WHERE workspace_membership.account_id = current_account_id
              AND workspace_membership.workspace_id = current_workspace_id
              AND workspace_membership.subject_id = membership.subject_id
          )
        );
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
        true
      );
      RETURN keys;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
        true
      );
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON FUNCTION %I.session_private_actor_visible_keys() FROM PUBLIC',
    data_schema
  );
  FOR role_name IN
    SELECT DISTINCT r.rolname
    FROM pg_catalog.pg_roles r
    WHERE r.rolname = 'opengeni_app'
      OR r.rolname IN (
        SELECT configured.value
        FROM pg_catalog.jsonb_array_elements_text(
          coalesce(
            nullif(pg_catalog.current_setting('opengeni.migration_application_roles', true), ''),
            '[]'
          )::jsonb
        ) configured(value)
      )
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %I.session_private_actor_visible_keys() TO %I',
      data_schema,
      role_name
    );
  END LOOP;
END
$session_private_actor_visible_keys$;

DO $session_policy_fast_paths$
DECLARE
  data_schema text := current_schema();
  policy record;
  private_call text := 'session_private_actor_visible(account_id, workspace_id, owner_organization_membership_id, owner_subject_id)';
  qualified_private_call text;
  guarded_private_call text;
  visibility_prefix text;
  site_prefix text := 'site_access_root_id IS NULL';
  protocol_prefix text :=
    'pg_catalog.current_setting(''opengeni.session_variable_set_attachments_v1'', true) = ''1''';
  new_qual text;
  new_check text;
  prefix text;
  rewritten integer := 0;
BEGIN
  qualified_private_call := pg_catalog.format(
    '%I.session_private_actor_visible(account_id, workspace_id, owner_organization_membership_id, owner_subject_id)',
    data_schema
  );
  guarded_private_call := pg_catalog.format(
    '(owner_subject_id IN ('
      || 'nullif(pg_catalog.current_setting(''opengeni.subject_id'', true), ''''), '
      || 'nullif(pg_catalog.current_setting(''opengeni.initiating_human_subject_id'', true), ''''))'
      || ' AND %I.session_private_actor_visible(account_id, workspace_id, owner_organization_membership_id, owner_subject_id))',
    data_schema
  );
  -- Every disjunct below is already a disjunct of the installed predicate
  -- (the third one implies session_private_actor_visible), so prefixing them
  -- changes evaluation order and cost, never the result.
  visibility_prefix := pg_catalog.format(
    'nullif(pg_catalog.current_setting(''opengeni.subject_id'', true), '''') IS NULL'
      || ' OR visibility = ''workspace_shared'''
      || ' OR (workspace_id = nullif(pg_catalog.current_setting(''opengeni.workspace_id'', true), '''')::uuid'
      || ' AND account_id = nullif(pg_catalog.current_setting(''opengeni.account_id'', true), '''')::uuid'
      || ' AND (owner_organization_membership_id::text || '':'' || owner_subject_id)'
      || ' = ANY ((SELECT %I.session_private_actor_visible_keys())::text[]))',
    data_schema
  );
  FOR policy IN
    SELECT
      p.polname,
      p.polpermissive,
      p.polcmd,
      pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS qual,
      pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
    FROM pg_catalog.pg_policy p
    WHERE p.polrelid = pg_catalog.format('%I.sessions', data_schema)::regclass
      AND p.polname IN (
        'session_visibility_isolation',
        'site_viewer_isolation',
        'sessions_variable_set_attachments_protocol_v1'
      )
  LOOP
    IF policy.polpermissive OR policy.polcmd <> '*'
      OR policy.qual IS NULL OR policy.check_expr IS NULL THEN
      RAISE EXCEPTION 'Unexpected sessions policy contract: %', policy.polname
        USING ERRCODE = '55000';
    END IF;
    new_qual := policy.qual;
    new_check := policy.check_expr;
    IF policy.polname = 'session_visibility_isolation' THEN
      prefix := visibility_prefix;
      -- Skip the per-row SECURITY DEFINER call when neither acting subject
      -- owns the session: the helper returns false before reading anything.
      IF pg_catalog.strpos(new_qual, qualified_private_call) > 0 THEN
        new_qual := pg_catalog.replace(new_qual, qualified_private_call, guarded_private_call);
        new_check := pg_catalog.replace(new_check, qualified_private_call, guarded_private_call);
      ELSE
        new_qual := pg_catalog.replace(new_qual, private_call, guarded_private_call);
        new_check := pg_catalog.replace(new_check, private_call, guarded_private_call);
      END IF;
      IF new_qual = policy.qual OR new_check = policy.check_expr THEN
        RAISE EXCEPTION 'session_visibility_isolation has no private-actor predicate to guard'
          USING ERRCODE = '55000';
      END IF;
    ELSIF policy.polname = 'site_viewer_isolation' THEN
      prefix := site_prefix;
    ELSE
      prefix := protocol_prefix;
    END IF;
    EXECUTE pg_catalog.format(
      'ALTER POLICY %I ON %I.sessions USING ((%s) OR (%s)) WITH CHECK ((%s) OR (%s))',
      policy.polname,
      data_schema,
      prefix,
      new_qual,
      prefix,
      new_check
    );
    rewritten := rewritten + 1;
  END LOOP;
  IF rewritten <> 3 THEN
    RAISE EXCEPTION 'Missing sessions policy contract (% of 3 found)', rewritten
      USING ERRCODE = '55000';
  END IF;
END
$session_policy_fast_paths$;

DO $session_child_policy_inline_probe$
DECLARE
  data_schema text := current_schema();
  policy record;
  call_pattern text :=
    '(?:(?:"[^"]+"|[a-z_][a-z0-9_]*)\.)?session_reference_visible\(\s*([a-z_][a-z0-9_]*)\s*,\s*([a-z_][a-z0-9_]*)\s*,\s*([a-z_][a-z0-9_]*)\s*\)';
  replacement text;
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
        pg_catalog.pg_get_expr(p.polqual, p.polrelid) LIKE '%session_reference_visible(%'
        OR pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%session_reference_visible(%'
      )
    ORDER BY c.relname, p.polname
  LOOP
    -- The helper was: session IS NULL OR EXISTS (visible sessions row). The
    -- probe runs as the querying role, so the sessions policies still apply.
    replacement := pg_catalog.format(
      '(%1$I.\3 IS NULL OR EXISTS (SELECT 1 FROM %2$I.sessions session_row'
        || ' WHERE session_row.account_id = %1$I.\1'
        || ' AND session_row.workspace_id = %1$I.\2'
        || ' AND session_row.id = %1$I.\3))',
      policy.relname,
      data_schema
    );
    new_qual := CASE WHEN policy.qual IS NULL THEN NULL
      ELSE pg_catalog.regexp_replace(policy.qual, call_pattern, replacement, 'g') END;
    new_check := CASE WHEN policy.check_expr IS NULL THEN NULL
      ELSE pg_catalog.regexp_replace(policy.check_expr, call_pattern, replacement, 'g') END;
    IF coalesce(new_qual, '') LIKE '%session_reference_visible(%'
      OR coalesce(new_check, '') LIKE '%session_reference_visible(%' THEN
      RAISE EXCEPTION 'Unrecognised session_reference_visible call in policy % on %',
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
  RAISE NOTICE 'inlined session visibility probe into % policies', rewritten;
END
$session_child_policy_inline_probe$;
