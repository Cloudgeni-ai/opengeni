-- deployment-mode: rolling
-- claim_browser_state_artifact_cleanup (1692) reads and updates browser_state_artifacts under its own
-- 'browser_artifact_cleanup' maintenance claim (1681). These policies let the routine's
-- owner do that without BYPASSRLS, the posture in docs/deployment.md. They
-- apply to that owner role alone, so the runtime role never evaluates them.
-- Each is an InitPlan, evaluated once per statement, never per row, and
-- admits only a transaction holding the claim, which only that SECURITY
-- DEFINER routine opens and removes before it returns. An owner that bypasses
-- row security (production's) never evaluates them.
-- One table per migration, so CREATE POLICY holds ACCESS EXCLUSIVE on this
-- table alone. Each attempt waits at most 300 ms for the lock, so queries
-- queued behind it stall no longer than that; a busy table is retried after a
-- short random pause (under 20 s in all). Rerunning finds the policies and
-- changes nothing.
DO $migration$
DECLARE
  target constant regclass := 'browser_state_artifacts'::regclass;
  claimer constant regprocedure := 'opengeni_private.claim_browser_state_artifact_cleanup(bigint,integer)'::regprocedure;
  operation constant text := 'browser_artifact_cleanup';
  commands constant text[] := ARRAY['select', 'update'];
  owner_role name;
  command text;
  policy_name name;
  attempt integer;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(routine.proowner) INTO STRICT owner_role
  FROM pg_catalog.pg_proc routine WHERE routine.oid = claimer;
  FOR attempt IN 1..30 LOOP
    BEGIN
      PERFORM pg_catalog.set_config('lock_timeout', '300ms', true);
      FOREACH command IN ARRAY commands LOOP
        policy_name := pg_catalog.format('maintenance_%s_%s', operation, command);
        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_policy policy
          WHERE policy.polrelid = target AND policy.polname = policy_name
        ) THEN
          EXECUTE pg_catalog.format(
            'CREATE POLICY %I ON %s FOR %s TO %I %s ((SELECT '
            'opengeni_private.maintenance_claim_active((CURRENT_USER)::text, %L::text)))',
            policy_name, target, pg_catalog.upper(command), owner_role,
            CASE command WHEN 'insert' THEN 'WITH CHECK' ELSE 'USING' END, operation);
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
