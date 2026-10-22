-- deployment-mode: rolling
-- Replies the person hears in a live voice call are not replies to catch up
-- on. While a session has an active realtime call, a finished turn is spoken
-- back in that call, so it neither refreshes the session's reply item nor
-- alerts the phone. A turn that finishes after the call ended (or after its
-- lease lapsed) still does: the person did not hear it. Only the shared
-- "hands back" check changes; both triggers already consult it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- True when the session is back with the person after this turn, outside a live call.
CREATE OR REPLACE FUNCTION opengeni_private.session_hands_back_v1(p_session_id uuid, p_turn_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $hands_back$
  SELECT NOT EXISTS (
      SELECT 1 FROM sessions session
      WHERE session.id = p_session_id
        AND session.input_wait_turn_id = p_turn_id
        AND (session.input_wait_until IS NULL OR session.input_wait_until > now())
    )
    AND NOT EXISTS (
      SELECT 1 FROM session_goals goal
      WHERE goal.session_id = p_session_id AND goal.status = 'active'
    )
    AND NOT EXISTS (
      SELECT 1 FROM session_turns turn
      WHERE turn.session_id = p_session_id AND turn.status = 'queued'
        AND turn.id <> p_turn_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM session_realtime_modes call
      WHERE call.session_id = p_session_id AND call.state = 'active'
        AND call.lease_expires_at > now()
    )
$hands_back$;

DO $inbox_skip_live_call_replies$
DECLARE
  target_schema text := current_schema();
BEGIN
  REVOKE ALL ON FUNCTION opengeni_private.session_hands_back_v1(uuid,uuid) FROM PUBLIC;
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.session_hands_back_v1(uuid,uuid) SET search_path = pg_catalog, %I, pg_temp',
    target_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.session_hands_back_v1(uuid,uuid) TO opengeni_app;
  END IF;
END $inbox_skip_live_call_replies$;
