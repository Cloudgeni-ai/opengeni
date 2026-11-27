-- deployment-mode: rolling
-- Five SECURITY DEFINER claimers read and update every tenant's rows but
-- open no maintenance capability, so under an owner without BYPASSRLS (the
-- posture in docs/deployment.md) FORCE ROW LEVEL SECURITY hides every row
-- and they claim nothing. 1692 gives each its own maintenance claim; this
-- adds those five operations to the claim table's allowed list, keeping every
-- operation it already allows:
--   browser_artifact_cleanup  claim_browser_state_artifact_cleanup
--   browser_upload_cleanup    claim_browser_state_upload_cleanup
--   memory_slack_delivery     claim_memory_slack_publication
--   slack_app_home            claim_slack_app_home_refresh
--   slack_inbox               claim_slack_interaction_inbox
-- Rolling: the list only grows, and no binary writes the new operations
-- before 1692. The table holds a row only during one routine call, so the
-- check validates at once. ALTER TABLE holds ACCESS EXCLUSIVE on this table
-- alone; each attempt waits at most 300 ms for it, so claimers queued behind
-- it stall no longer than that, and a busy table is retried after a short
-- random pause (under 20 s in all). Rerunning finds every operation and
-- changes nothing.
DO $migration$
DECLARE
  target constant regclass := 'opengeni_private.maintenance_claim_capabilities'::regclass;
  check_name constant name := 'maintenance_claim_capabilities_operation_check';
  added constant text[] := ARRAY['browser_artifact_cleanup', 'browser_upload_cleanup',
    'memory_slack_delivery', 'slack_app_home', 'slack_inbox'];
  allowed text[];
  attempt integer;
BEGIN
  FOR attempt IN 1..30 LOOP
    BEGIN
      PERFORM pg_catalog.set_config('lock_timeout', '300ms', true);
      SELECT pg_catalog.array_agg(operation.value[1] ORDER BY operation.position)
      INTO allowed
      FROM pg_catalog.pg_constraint constraint_row
      CROSS JOIN LATERAL pg_catalog.regexp_matches(
        pg_catalog.pg_get_constraintdef(constraint_row.oid), '''([a-z_]+)''::text', 'g')
        WITH ORDINALITY AS operation(value, position)
      WHERE constraint_row.conrelid = target AND constraint_row.conname = check_name
        AND constraint_row.contype = 'c';
      IF allowed IS NULL THEN
        RAISE EXCEPTION 'maintenance claim operation check is missing';
      END IF;
      IF NOT added <@ allowed THEN
        SELECT pg_catalog.array_agg(operation ORDER BY position) INTO allowed
        FROM (
          SELECT existing.operation, existing.position
          FROM pg_catalog.unnest(allowed) WITH ORDINALITY AS existing(operation, position)
          UNION ALL
          SELECT new_operation.operation, pg_catalog.cardinality(allowed) + new_operation.position
          FROM pg_catalog.unnest(added) WITH ORDINALITY AS new_operation(operation, position)
          WHERE new_operation.operation <> ALL (allowed)
        ) operations;
        EXECUTE pg_catalog.format(
          'ALTER TABLE %s DROP CONSTRAINT %I, ADD CONSTRAINT %I CHECK (operation = ANY (ARRAY[%s]))',
          target, check_name, check_name,
          (SELECT pg_catalog.string_agg(pg_catalog.format('%L::text', operation), ', ' ORDER BY position)
            FROM pg_catalog.unnest(allowed) WITH ORDINALITY AS listed(operation, position)));
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
