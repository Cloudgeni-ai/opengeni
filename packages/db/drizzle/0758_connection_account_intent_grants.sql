-- deployment-mode: rolling
-- Take PUBLIC's EXECUTE off the two routines 0755 created.
--
-- 0755 created `connection_account_intent_is_valid(jsonb)` and
-- `prevent_connection_account_intent_mutation()` without revoking the default
-- PUBLIC grant, so every role (including the dedicated artifact materializer
-- and outbox dispatcher, which must hold only their own routines) could call
-- them. Neither routine reads data, so nothing leaked; this restores least
-- privilege. The validator backs the sessions, session_turns and
-- session_realtime_modes CHECK constraints, so the application role that
-- writes those rows keeps EXECUTE on it. A trigger routine needs no grant to
-- fire.
--
-- Rolling: the application role keeps every privilege it uses.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

REVOKE ALL ON FUNCTION opengeni_private.connection_account_intent_is_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.prevent_connection_account_intent_mutation() FROM PUBLIC;
DO $intent_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.connection_account_intent_is_valid(jsonb)
      TO opengeni_app;
  END IF;
END
$intent_grants$;
