-- deployment-mode: maintenance
-- Interaction operation receipts use the public controller-error enum. The
-- durable resource keeps the exact internal loss reason; an ambiguous physical
-- operation must expose the canonical `outcome_unknown` code so idempotent
-- lifecycle replay remains parseable.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- `interaction_operations` is FORCE-RLS. Production migrations run as its
-- NOSUPERUSER/NOBYPASSRLS owner without tenant GUCs, so the repair would
-- otherwise see zero rows. This maintenance migration is one transaction;
-- any failure rolls the temporary owner-only posture change back as well.
ALTER TABLE "interaction_operations" NO FORCE ROW LEVEL SECURITY;

DO $interaction_error_code_repair$
DECLARE
  data_schema text := current_schema();
  reaper_definition text;
  repaired_definition text;
  repaired_rows integer := 0;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(proc.oid)
  INTO reaper_definition
  FROM pg_catalog.pg_proc proc
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = proc.pronamespace
  WHERE namespace.nspname = 'opengeni_private'
    AND proc.proname = 'reap_stale_interaction_transitions'
    AND pg_catalog.pg_get_function_identity_arguments(proc.oid) = 'p_interaction_holder_ttl_ms bigint';

  IF reaper_definition IS NULL THEN
    RAISE EXCEPTION 'interaction transition reaper is missing';
  END IF;

  repaired_definition := pg_catalog.replace(
    reaper_definition,
    'error_code = ''controller_transition_expired''',
    'error_code = ''outcome_unknown'''
  );
  IF repaired_definition = reaper_definition THEN
    IF pg_catalog.strpos(reaper_definition, 'error_code = ''outcome_unknown''') = 0 THEN
      RAISE EXCEPTION 'interaction transition reaper error-code contract is unrecognized';
    END IF;
  ELSE
    EXECUTE repaired_definition;
  END IF;

  EXECUTE format($repair$
    UPDATE %1$I.interaction_operations operation
    SET error_code = 'outcome_unknown'
    WHERE operation.state = 'outcome_unknown'
      AND operation.error_code = 'controller_transition_expired'
  $repair$, data_schema);
  GET DIAGNOSTICS repaired_rows = ROW_COUNT;

  RAISE NOTICE 'Repaired % interaction operation error-code receipt(s).', repaired_rows;
END
$interaction_error_code_repair$;

ALTER TABLE "interaction_operations" FORCE ROW LEVEL SECURITY;

RESET statement_timeout;
RESET lock_timeout;
