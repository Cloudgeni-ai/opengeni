-- deployment-mode: rolling
-- Preserve the installed usage-export lineage and analytics contract. Internal
-- reservation holds/releases never leave the deployment.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $reservation_export$
DECLARE
  original text;
  definition text;
  anchor text := 'SELECT c.usage_events_enabled INTO v_enabled';
BEGIN
  SELECT pg_get_functiondef('opengeni_private.enqueue_host_usage_event_export()'::regprocedure)
  INTO original;
  IF array_length(string_to_array(original, anchor), 1) <> 2
    OR position('v_surface' IN original) = 0
    OR position('v_model_provider' IN original) = 0 THEN
    RAISE EXCEPTION 'Usage reservation export source contract changed' USING ERRCODE = '55000';
  END IF;
  definition := replace(original, anchor,
    'IF NEW.event_type LIKE ''%.reserved'' THEN
        RETURN NEW;
      END IF;
      ' || anchor);
  EXECUTE definition;
END
$reservation_export$;
