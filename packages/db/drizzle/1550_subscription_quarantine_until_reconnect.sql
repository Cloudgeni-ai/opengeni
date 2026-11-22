-- deployment-mode: rolling
-- A provider may quarantine a refused connection until reconnect rather than
-- scheduling another production request with it. Keep the lease, credential
-- generation, scope, and one-day bound for timed quarantines unchanged.
DO $quarantine_until_reconnect$
DECLARE
  definition text := pg_get_functiondef(
    'opengeni_private.quarantine_subscription_core_connection(text, uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, text, text, timestamp with time zone)'::regprocedure);
  anchor constant text := $anchor$OR (p_status = 'error' AND (p_retry_at IS NULL
          OR p_retry_at <= pg_catalog.clock_timestamp()$anchor$;
  replacement constant text := $replacement$OR (p_status = 'error' AND p_retry_at IS NOT NULL
          AND (p_retry_at <= pg_catalog.clock_timestamp()$replacement$;
BEGIN
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'subscription quarantine retry guard anchor changed';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$quarantine_until_reconnect$;
