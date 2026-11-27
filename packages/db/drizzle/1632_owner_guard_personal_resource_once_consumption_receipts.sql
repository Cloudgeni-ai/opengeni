-- deployment-mode: rolling
-- Owner-only capability calls in the row policies of personal_resource_once_consumption_receipts get an inline
-- owner guard. session_tenancy_fence_owner_policy_active and
-- scoped_compute_policy_capability_active are SECURITY DEFINER functions that
-- return false at once unless the caller is the table owner (p_actor IS
-- DISTINCT FROM p_expected_owner on these two non-null arguments). The
-- runtime role never is, yet it called them for every row it filtered out.
-- f((CURRENT_USER)::text, 'owner'::text, ...) becomes
-- (((CURRENT_USER)::text = 'owner'::text) AND f((CURRENT_USER)::text, 'owner'::text, ...)),
-- which admits exactly the same rows. One table per migration, so ALTER POLICY
-- holds ACCESS EXCLUSIVE on this table alone. Each attempt waits at most
-- 300 ms for the lock, so queries queued behind it stall no longer than that;
-- a busy table is retried after a short random pause (under 20 s in all).
-- Rerunning finds every call guarded and changes nothing.
DO $migration$
DECLARE
  target constant regclass := 'personal_resource_once_consumption_receipts'::regclass;
  functions constant text :=
    '(session_tenancy_fence_owner_policy_active|scoped_compute_policy_capability_active)';
  -- An unqualified call: not preceded by a name character, a dot or a quote.
  boundary constant text := '(^|[^[:alnum:]_."])';
  -- Any call, however qualified or quoted.
  any_call constant text := functions || '"?\(';
  owner_literal constant text := '(''(?:[^'']|'''')*''::text)';
  arguments constant text := '((?:[^()'']|''(?:[^'']|'''')*''|\([0-9]+\))*)';
  call_pattern constant text := boundary || functions
    || '\(\(CURRENT_USER\)::text, ' || owner_literal || ', ' || arguments || '\)';
  guarded_pattern constant text := boundary
    || '\(\(\(CURRENT_USER\)::text = ' || owner_literal || '\) AND ' || functions
    || '\(\(CURRENT_USER\)::text, \2, ' || arguments || '\)\)';
  policy record;
  plain_qual text;
  plain_check text;
  next_qual text;
  next_check text;
  attempt integer;
BEGIN
  FOR attempt IN 1..30 LOOP
    BEGIN
      PERFORM pg_catalog.set_config('lock_timeout', '300ms', true);
      FOR policy IN
        SELECT pol.polname,
          pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS qual,
          pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS with_check
        FROM pg_catalog.pg_policy pol
        WHERE pol.polrelid = target
        ORDER BY pol.polname
      LOOP
        -- Strip existing guards first, so a rerun adds none. Every call must be
        -- unqualified with the expected shape; anything else stops the migration.
        plain_qual := regexp_replace(policy.qual, guarded_pattern, '\1\3((CURRENT_USER)::text, \2, \4)', 'g');
        plain_check := regexp_replace(policy.with_check, guarded_pattern, '\1\3((CURRENT_USER)::text, \2, \4)', 'g');
        IF (SELECT count(*) FROM regexp_matches(concat_ws(' ', plain_qual, plain_check), any_call, 'g'))
          <> (SELECT count(*) FROM regexp_matches(concat_ws(' ', plain_qual, plain_check), call_pattern, 'g'))
        THEN
          RAISE EXCEPTION 'policy % on % has an unexpected owner capability call', policy.polname, target;
        END IF;
        next_qual := regexp_replace(plain_qual, call_pattern, '\1(((CURRENT_USER)::text = \3) AND \2((CURRENT_USER)::text, \3, \4))', 'g');
        next_check := regexp_replace(plain_check, call_pattern, '\1(((CURRENT_USER)::text = \3) AND \2((CURRENT_USER)::text, \3, \4))', 'g');
        IF next_qual IS DISTINCT FROM policy.qual OR next_check IS DISTINCT FROM policy.with_check THEN
          EXECUTE pg_catalog.format('ALTER POLICY %I ON %s %s', policy.polname, target, concat_ws(' ',
            CASE WHEN next_qual IS NOT NULL THEN pg_catalog.format('USING (%s)', next_qual) END,
            CASE WHEN next_check IS NOT NULL THEN pg_catalog.format('WITH CHECK (%s)', next_check) END));
        END IF;
      END LOOP;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      -- Nothing is held after the rollback to this block; wait and retry.
      IF attempt = 30 THEN RAISE; END IF;
      PERFORM pg_catalog.pg_sleep(pg_catalog.random() * least(0.05 * attempt, 0.4));
    END;
  END LOOP;
END
$migration$;
