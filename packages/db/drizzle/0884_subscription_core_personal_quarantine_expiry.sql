-- deployment-mode: rolling
-- A 403 quarantine (`status = 'error'` with `health_retry_at`, written only by
-- the quarantine routine; any other status or error write drops the retry
-- time) ends by itself at `health_retry_at`. Only the recovery routine (0707)
-- stored that transition, and only from an accepted turn, so until some turn
-- ran, every reader that decides availability kept seeing `error`: session
-- creation refused the account's models, and a person whose only personal
-- connection was quarantined could not start the turn that would recover it.
--
-- Availability reads now derive the effective status. The application's
-- shared-connection reads do it in their own SQL; personal connections are
-- visible only through the owner reader, which this migration patches to
-- return the same effective `status` and `last_error`: an ended quarantine
-- reads `active` with no error, exactly what the recovery routine would store.
--
-- Rolling: the routine is redefined from its live source (drift-checked
-- anchor, never a restated body, as 0730 does), keeping its signature,
-- result columns, security mode, search path, writer context check, owner
-- capability grant and drop. No table, policy, lock or other routine changes;
-- the previous release reads the same columns and only sees an ended
-- quarantine as available sooner.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $personal_quarantine_expiry$
DECLARE
  definition text;
  anchor constant text :=
    $old$connection.provider_account_id, connection.status, connection.last_error,$old$;
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.subscription_core_personal_connections(text,uuid,uuid,text)'::regprocedure);
  IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
    RAISE EXCEPTION 'subscription core personal connections source changed before 0884';
  END IF;
  definition := replace(definition, anchor, $new$connection.provider_account_id,
          CASE WHEN connection.status = 'error'
              AND connection.health_retry_at <= pg_catalog.clock_timestamp()
            THEN 'active' ELSE connection.status END,
          CASE WHEN connection.status = 'error'
              AND connection.health_retry_at <= pg_catalog.clock_timestamp()
            THEN NULL ELSE connection.last_error END,$new$);
  EXECUTE definition;
END
$personal_quarantine_expiry$;
