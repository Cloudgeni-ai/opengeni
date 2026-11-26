-- deployment-mode: rolling
-- Row policies call session_tenancy_fence_owner_policy_active and
-- scoped_compute_policy_capability_active once per row they test. Both are
-- SECURITY DEFINER functions with their own search_path, so every call pays a
-- definer switch, and both return false at once unless the caller is the
-- table owner. The runtime role never is, so a scan over rows outside its
-- tenant paid several of these calls per row for nothing. Each call is now
-- preceded by that same owner comparison, evaluated inline, so the function
-- runs only for the owner. Each function's first test is exactly
-- p_actor IS DISTINCT FROM p_expected_owner (or p_actor = p_expected_owner AND
-- ...) on the two non-null text arguments repeated here, so every policy
-- admits exactly the same rows. Both old and new binaries read the same
-- policies; no routine, grant or policy name changes.
SET LOCAL statement_timeout = '5min';

DO $migration$
DECLARE
  -- name((CURRENT_USER)::text, 'owner'::text, remaining simple arguments)
  call_pattern constant text :=
    '(session_tenancy_fence_owner_policy_active|scoped_compute_policy_capability_active)'
    || '\(\(CURRENT_USER\)::text, (''(?:[^'']|'''')*''::text), '
    || '((?:[^()'']|''(?:[^'']|'''')*''|\([0-9]+\))*)\)';
  name_pattern constant text :=
    '(session_tenancy_fence_owner_policy_active|scoped_compute_policy_capability_active)\(';
  replacement constant text := '(((CURRENT_USER)::text = \2) AND \1((CURRENT_USER)::text, \2, \3))';
  policy record;
  next_qual text;
  next_check text;
  clauses text;
BEGIN
  FOR policy IN
    SELECT DISTINCT pol.polname, pol.polrelid,
      pol.polrelid::regclass::text AS relation,
      pg_get_expr(pol.polqual, pol.polrelid) AS qual,
      pg_get_expr(pol.polwithcheck, pol.polrelid) AS with_check
    FROM pg_policy pol
    JOIN pg_depend dependency ON dependency.classid = 'pg_policy'::regclass
      AND dependency.objid = pol.oid AND dependency.refclassid = 'pg_proc'::regclass
    WHERE dependency.refobjid IN (
      'session_tenancy_fence_owner_policy_active(text, text, oid, uuid, boolean)'::regprocedure,
      'scoped_compute_policy_capability_active(text, text, text)'::regprocedure)
    ORDER BY relation, pol.polname
  LOOP
    -- Every call must have the expected shape; otherwise stop rather than
    -- leave a policy half rewritten.
    IF (SELECT count(*) FROM regexp_matches(coalesce(policy.qual, ''), name_pattern, 'g'))
        <> (SELECT count(*) FROM regexp_matches(coalesce(policy.qual, ''), call_pattern, 'g'))
      OR (SELECT count(*) FROM regexp_matches(coalesce(policy.with_check, ''), name_pattern, 'g'))
        <> (SELECT count(*) FROM regexp_matches(coalesce(policy.with_check, ''), call_pattern, 'g'))
    THEN
      RAISE EXCEPTION 'policy % on % has an unexpected owner capability call',
        policy.polname, policy.relation;
    END IF;
    next_qual := regexp_replace(policy.qual, call_pattern, replacement, 'g');
    next_check := regexp_replace(policy.with_check, call_pattern, replacement, 'g');
    clauses := concat_ws(' ',
      CASE WHEN next_qual IS NOT NULL THEN format('USING (%s)', next_qual) END,
      CASE WHEN next_check IS NOT NULL THEN format('WITH CHECK (%s)', next_check) END);
    EXECUTE format('ALTER POLICY %I ON %s %s', policy.polname, policy.relation, clauses);
  END LOOP;
END
$migration$;
