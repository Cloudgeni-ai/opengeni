-- deployment-mode: rolling
-- A scheduled occurrence whose model is retired or no longer in the catalog is
-- refused as a visible terminal run (`scheduled_model_unavailable`) instead of
-- exhausting activity retries and leaving no run. Preserve the immutable 0539
-- refusal lifecycle (as extended by 0552), adding only this reason. Exact
-- anchoring refuses an unexpected deployed guard definition. Old binaries never
-- write the new reason, so this is rolling-safe.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $scheduled_model_refusal$
DECLARE
  definition text:=pg_get_functiondef('opengeni_private.guard_scheduled_admission_refusal()'::regprocedure);
  anchor text:='''monthly_agent_run_limit'', ''allowance_exhausted'')';
BEGIN
  IF strpos(definition,anchor)=0 OR strpos(substr(definition,strpos(definition,anchor)+length(anchor)),anchor)>0 THEN
    RAISE EXCEPTION '0612 unexpected scheduled refusal guard definition' USING ERRCODE='55000';
  END IF;
  EXECUTE replace(definition,anchor,
    '''monthly_agent_run_limit'', ''allowance_exhausted'', ''scheduled_model_unavailable'')');
END $scheduled_model_refusal$;
