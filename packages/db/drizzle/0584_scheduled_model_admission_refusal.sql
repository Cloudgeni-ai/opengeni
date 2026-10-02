-- deployment-mode: rolling
-- A retired model refuses a fresh occurrence without accepting execution.
-- Add only the content-free reason; preserve every identity/immutability fence.
DO $scheduled_model_refusal$
DECLARE
  definition text := pg_get_functiondef('opengeni_private.guard_scheduled_admission_refusal()'::regprocedure);
  anchor text := '''scheduled_authority_unavailable'',';
BEGIN
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'unexpected scheduled refusal guard definition' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, anchor, anchor || ' ''scheduled_model_unavailable'',');
END $scheduled_model_refusal$;