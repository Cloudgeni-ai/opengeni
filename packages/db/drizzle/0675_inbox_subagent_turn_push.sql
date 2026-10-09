-- deployment-mode: rolling
-- A sub-agent's turns end back with the agent that started it, not with the
-- person. Its replies and failures already stay out of the inbox; they no
-- longer alert the phone either. Its questions and approvals still do, because
-- only a person can answer them.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE OR REPLACE FUNCTION opengeni_private.enqueue_native_push_for_session_event_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $event$
DECLARE
  v_rule text;
  v_body text;
BEGIN
  BEGIN
    v_rule := CASE NEW.type
      WHEN 'session.humanInput.requested' THEN 'needs_input'
      WHEN 'session.requiresAction' THEN 'needs_input'
      WHEN 'turn.completed' THEN 'reply_ready'
      WHEN 'turn.failed' THEN 'failed'
    END;
    v_body := CASE NEW.type
      WHEN 'session.humanInput.requested' THEN coalesce(
        NEW.payload #>> '{request,questions,0,prompt}', 'The agent has a question for you.')
      WHEN 'session.requiresAction' THEN 'Approve ' || coalesce(
        NEW.payload #>> '{approvals,0,display,toolName}', NEW.payload #>> '{approvals,0,name}',
        'a tool call') || '?'
      WHEN 'turn.completed' THEN 'The agent replied.'
      WHEN 'turn.failed' THEN 'The agent ran into a problem. Open the session to retry.'
    END;
    IF v_rule IN ('reply_ready', 'failed') AND EXISTS (
      SELECT 1 FROM sessions session
      WHERE session.id = NEW.session_id AND session.parent_session_id IS NOT NULL
    ) THEN
      v_rule := NULL;
    END IF;
    IF v_rule = 'reply_ready' AND NEW.turn_id IS NOT NULL
      AND NOT opengeni_private.session_hands_back_v1(NEW.session_id, NEW.turn_id) THEN
      v_rule := NULL;
    END IF;
    IF v_rule IS NOT NULL AND NEW.session_id IS NOT NULL THEN
      PERFORM opengeni_private.enqueue_native_push_v2(
        NEW.session_id, v_rule, NEW.id::text, NULL, left(v_body, 240), NEW.type,
        jsonb_build_object('sequence', NEW.sequence));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'native push enqueue skipped for event %: %', NEW.id, SQLSTATE;
  END;
  RETURN NULL;
END
$event$;

DO $inbox_subagent_turn_push$
DECLARE
  target_schema text := current_schema();
BEGIN
  REVOKE ALL ON FUNCTION opengeni_private.enqueue_native_push_for_session_event_v1() FROM PUBLIC;
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.enqueue_native_push_for_session_event_v1() '
      'SET search_path = pg_catalog, %I, pg_temp',
    target_schema
  );
END $inbox_subagent_turn_push$;
