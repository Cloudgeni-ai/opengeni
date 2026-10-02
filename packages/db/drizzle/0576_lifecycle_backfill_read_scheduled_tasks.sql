-- deployment-mode: rolling
-- Lifecycle fact backfill read access on scheduled_tasks (see 0565). Adds one
-- SELECT-only policy that is true only while the owner-run backfill holds its
-- transaction-bound capability, and admits that capability in the table's
-- restrictive SELECT policies; every other rule is unchanged. One table per
-- migration, so its ACCESS EXCLUSIVE policy lock is held only for this short
-- transaction. A lock timeout fails only this file before anything changes;
-- rerunning the migration is safe.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '1min';

DO $policy$
DECLARE
  target_table regclass := format('%I.%I', current_schema(), 'scheduled_tasks')::regclass;
  restrictive record;
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS lifecycle_backfill_read ON %s', target_table);
  EXECUTE format(
    'CREATE POLICY lifecycle_backfill_read ON %s AS PERMISSIVE FOR SELECT '
      'USING ((SELECT opengeni_private.lifecycle_backfill_read_active()))',
    target_table
  );
  FOR restrictive IN
    SELECT policy.polname, pg_get_expr(policy.polqual, policy.polrelid) AS qual
    FROM pg_policy policy
    WHERE policy.polrelid = target_table
      AND NOT policy.polpermissive
      AND policy.polcmd IN ('r', '*')
      AND policy.polqual IS NOT NULL
  LOOP
    IF position('lifecycle_backfill_read_active' IN restrictive.qual) = 0 THEN
      EXECUTE format(
        'ALTER POLICY %I ON %s USING ((%s) OR (SELECT opengeni_private.lifecycle_backfill_read_active()))',
        restrictive.polname, target_table, restrictive.qual
      );
    END IF;
  END LOOP;
END $policy$;
