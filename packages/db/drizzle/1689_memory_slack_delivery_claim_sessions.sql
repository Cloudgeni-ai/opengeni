-- deployment-mode: rolling
-- claim_memory_slack_publication (1692) reads sessions under its own
-- 'memory_slack_delivery' maintenance claim (1681): the restrictive
-- session_visibility_isolation policy on memory_slack_publications admits a
-- publication with a session only while that session row is visible. This
-- select policy lets the routine's owner see it without BYPASSRLS, the
-- posture in docs/deployment.md. It applies to that owner role alone, so the
-- runtime role never evaluates it.
-- sessions' own restrictive policies still apply on top of this permissive
-- one, and the pump passes them: session_visibility_isolation admits every
-- session while opengeni.subject_id is unset (the pump sets none),
-- sessions_variable_set_attachments_protocol_v1 requires the runtime's
-- protocol marker in application_name (the pump's connection carries it),
-- and site_viewer_isolation hides only site-access sessions, which publish
-- no Memory.
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
  target constant regclass := 'sessions'::regclass;
  claimer constant regprocedure := 'opengeni_private.claim_memory_slack_publication(uuid,integer)'::regprocedure;
  operation constant text := 'memory_slack_delivery';
  commands constant text[] := ARRAY['select'];
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
