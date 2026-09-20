-- deployment-mode: rolling
-- Logical turn closure may precede its already-admitted workspace capture.
-- Do not reclaim that sole warm holder and escalate the capture into a drain
-- while its original bounded deadline is still open. This grants no execution
-- authority and does not extend the deadline or change dead-worker recovery.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $warm_capture_holder_reclamation$
DECLARE
  definition text;
  patched text;
  lease_schema text;
  anchor constant text := E'            AND stale.kind = ''turn''\n            AND (';
  replacement text;
  occurrences integer;
BEGIN
  SELECT namespace.nspname INTO lease_schema
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE relation.oid = 'sandbox_leases'::regclass;
  SELECT pg_catalog.pg_get_functiondef(
    'opengeni_private.reap_sandbox_leases(bigint,bigint,bigint,bigint)'::regprocedure
  ) INTO definition;
  IF definition IS NULL OR lease_schema IS NULL
    OR pg_catalog.strpos(definition, pg_catalog.format('%I.sandbox_lease_holders', lease_schema)) = 0
  THEN
    RAISE EXCEPTION '0491 warm capture reaper prerequisite drift' USING ERRCODE = '55000';
  END IF;
  replacement := E'            AND stale.kind = ''turn''\n'
    || E'            -- 0491 bounded warm capture holder; not execution authority.\n'
    || E'            AND NOT EXISTS (\n'
    || pg_catalog.format(E'              SELECT 1 FROM %I.sandbox_leases capture_lease\n', lease_schema)
    || E'              WHERE capture_lease.id = stale.lease_id\n'
    || E'                AND capture_lease.liveness = ''warm''\n'
    || E'                AND capture_lease.archive_capture_id IS NOT NULL\n'
    || E'                AND capture_lease.archive_capture_published_at IS NULL\n'
    || E'                AND capture_lease.archive_capture_deadline_at > pg_catalog.now()\n'
    || E'            )\n            AND (';
  IF pg_catalog.strpos(definition, '0491 bounded warm capture holder') > 0 THEN
    IF pg_catalog.strpos(definition, replacement) = 0 THEN
      RAISE EXCEPTION '0491 warm capture reaper replay drift' USING ERRCODE = '55000';
    END IF;
  ELSE
    occurrences := (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, anchor, ''))) / pg_catalog.length(anchor);
    IF occurrences <> 1 THEN
      RAISE EXCEPTION '0491 warm capture reaper anchor drift' USING ERRCODE = '55000';
    END IF;
    patched := pg_catalog.replace(definition, anchor, replacement);
    EXECUTE patched;
  END IF;
END
$warm_capture_holder_reclamation$;

RESET statement_timeout;
RESET lock_timeout;