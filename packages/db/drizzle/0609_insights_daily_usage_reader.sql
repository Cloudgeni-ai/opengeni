-- deployment-mode: rolling
-- Data-source substitution only. Keep the existing function/OID, owner, ACL,
-- settings, authority checks, live metadata joins and privacy projection intact.
-- The raw input remains installed for bounded details and parity diagnostics.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='10min';
DO $source_switch$
DECLARE
  target regprocedure:='opengeni_private.insights_scoped_usage_rows(uuid,uuid,timestamptz,timestamptz,text,uuid[],boolean)'::regprocedure;
  definition text;
  updated text;
  source_call text;
  replacement text;
  data_owner oid;
  expected_path text;
BEGIN
  SELECT relowner INTO STRICT data_owner FROM pg_class
    WHERE oid=format('%I.model_call_facts',current_schema())::regclass;
  expected_path:=format('search_path=pg_catalog, %I, opengeni_private, pg_temp',current_schema());
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner=data_owner
    AND prosecdef AND prorettype='jsonb'::regtype AND proretset
    AND expected_path=ANY(proconfig) AND 'jit=off'=ANY(proconfig)
    AND 'enable_nestloop=off'=ANY(proconfig) AND 'plan_cache_mode=force_custom_plan'=ANY(proconfig)) THEN
    RAISE EXCEPTION 'Daily source substitution requires the exact existing owner reader posture';
  END IF;
  definition:=pg_get_functiondef(target);
  updated:=definition;
  FOREACH source_call IN ARRAY ARRAY[
    'opengeni_private.insights_raw_amount_inputs(a,w.id,p_since,p_until)',
    'opengeni_private.insights_raw_amount_inputs(a,null,p_since,p_until)'
  ] LOOP
    IF (length(updated)-length(replace(updated,source_call,'')))/length(source_call)<>1 THEN
      RAISE EXCEPTION 'Daily source substitution requires exactly one reviewed call site: %',source_call;
    END IF;
    replacement:=replace(source_call,'insights_raw_amount_inputs','insights_rollup_amount_inputs');
    replacement:=left(replacement,length(replacement)-1)||',p_granularity)';
    updated:=replace(updated,source_call,replacement);
  END LOOP;
  IF position('insights_raw_amount_inputs' IN updated)>0 THEN
    RAISE EXCEPTION 'Daily source substitution found an unreviewed raw call site';
  END IF;
  EXECUTE updated;
  -- CREATE OR REPLACE must not move identity/authority or alter any other bytes.
  IF pg_get_functiondef(target) IS DISTINCT FROM updated THEN
    RAISE EXCEPTION 'Daily source substitution changed more than the two amount calls';
  END IF;
END
$source_switch$;
RESET statement_timeout;
RESET lock_timeout;