-- deployment-mode: rolling
-- The wake repair inventories (1677) read session_system_update_outbox under the wake
-- dispatcher's 'wakes' maintenance claim. This gives session_system_update_outbox the select
-- policy the dispatcher's other tables already have, so an owner without
-- BYPASSRLS sees its rows inside such a call. The policy is an InitPlan,
-- evaluated once per statement, never per row; it admits only a transaction
-- holding the claim, which only the dispatcher's SECURITY DEFINER routines
-- open, and an owner that bypasses row security never evaluates it.
-- One table per migration, so CREATE POLICY holds ACCESS EXCLUSIVE on this
-- table alone. Each attempt waits at most 300 ms for the lock, so queries
-- queued behind it stall no longer than that; a busy table is retried after a
-- short random pause (under 20 s in all). Rerunning finds the policy and
-- changes nothing.
DO $migration$
DECLARE
  target constant regclass := 'session_system_update_outbox'::regclass;
  attempt integer;
BEGIN
  FOR attempt IN 1..30 LOOP
    BEGIN
      PERFORM pg_catalog.set_config('lock_timeout', '300ms', true);
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_policy policy
        WHERE policy.polrelid = target AND policy.polname = 'maintenance_wakes_select'
      ) THEN
        EXECUTE pg_catalog.format(
          'CREATE POLICY maintenance_wakes_select ON %s FOR SELECT USING '
          '((SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, %L::text)))',
          target, 'wakes');
      END IF;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      -- Nothing is held after the rollback to this block; wait and retry.
      IF attempt = 30 THEN RAISE; END IF;
      PERFORM pg_catalog.pg_sleep(pg_catalog.random() * least(0.05 * attempt, 0.4));
    END;
  END LOOP;
END
$migration$;
