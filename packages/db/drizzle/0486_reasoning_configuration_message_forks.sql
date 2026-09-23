-- deployment-mode: rolling
-- Configuration controls occupy fractional positions but are not compaction.
-- Rewrite only the message-boundary overload's rejection predicate, retaining
-- ordered JSON copying and all authority/provenance checks installed previously.
DO $migration$
DECLARE
  candidate oid;
  definition text;
  updated text;
BEGIN
  SELECT oid INTO STRICT candidate FROM pg_proc
  WHERE proname = 'fork_session_content'
    AND pronamespace = current_schema()::regnamespace
    AND pronargs = 11;
  definition := pg_get_functiondef(candidate);
  updated := replace(definition,
    'history.position <> trunc(history.position)',
    $predicate$(history.position <> trunc(history.position) AND (
          history.item ->> 'type' = 'unknown'
          AND history.item #> '{opengeniReasoningConfiguration,version}' = '1'::jsonb
          AND history.item #>> '{opengeniReasoningConfiguration,baselineEffort}'
            IN ('low', 'medium', 'high', 'xhigh', 'max')
          AND history.item #>> '{opengeniReasoningConfiguration,effort}'
            IN ('low', 'medium', 'high', 'xhigh', 'max')
          AND jsonb_typeof(history.item #> '{opengeniReasoningConfiguration,turnId}') = 'string'
          AND history.item #>> '{providerData,type}' = 'configuration_update'
          AND history.item #>> '{providerData,reasoning,effort}' =
            history.item #>> '{opengeniReasoningConfiguration,effort}'
        ) IS NOT TRUE)$predicate$);
  IF updated = definition THEN
    RAISE EXCEPTION 'reasoning configuration fork predicate rewrite did not match';
  END IF;
  EXECUTE updated;
END
$migration$;
