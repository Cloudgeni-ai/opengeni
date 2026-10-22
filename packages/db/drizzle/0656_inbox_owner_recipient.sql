-- deployment-mode: rolling
-- The inbox and phone pushes reach the person a session works for: its owner,
-- else the person who started it. Sub-agent sessions are started by a service
-- on a person's behalf but owned by that person, so their questions, approvals,
-- paused goals and notifications now reach that person. Replies and failures
-- still notify only for sessions a person started, so sub-agents never buzz the
-- phone on every reply.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION opengeni_private.session_recipient_v1(p_owner text, p_creator text)
RETURNS text LANGUAGE sql IMMUTABLE AS $recipient$
  SELECT CASE
    WHEN p_owner LIKE 'user:%' THEN p_owner
    WHEN p_creator LIKE 'user:%' THEN p_creator
  END
$recipient$;
REVOKE ALL ON FUNCTION opengeni_private.session_recipient_v1(text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION opengeni_private.project_inbox_for_session_event_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $event$
DECLARE
  v_recipient text;
  v_question jsonb;
  v_count integer;
  v_approval jsonb;
  v_new boolean;
  v_choices jsonb;
BEGIN
  BEGIN
    SELECT opengeni_private.session_recipient_v1(session.owner_subject_id,
        session.created_by_subject_id) INTO v_recipient
    FROM sessions session WHERE session.id = NEW.session_id;
    IF v_recipient IS NULL THEN
      RETURN NULL;
    END IF;

    CASE NEW.type
    WHEN 'session.humanInput.requested' THEN
      v_question := NEW.payload #> '{request,questions,0}';
      v_count := coalesce(jsonb_array_length(NEW.payload #> '{request,questions}'), 1);
      v_choices := '[]'::jsonb;
      IF v_count = 1 AND v_question ->> 'kind' = 'single_select'
        AND jsonb_typeof(v_question -> 'options') = 'array'
        AND jsonb_array_length(v_question -> 'options') BETWEEN 2 AND 4 THEN
        SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id', option.value ->> 'id', 'label', left(option.value ->> 'label', 40))
            ORDER BY option.ordinality), '[]'::jsonb)
          INTO v_choices
        FROM jsonb_array_elements(v_question -> 'options') WITH ORDINALITY AS option(value, ordinality)
        WHERE option.value ->> 'id' IS NOT NULL AND option.value ->> 'label' IS NOT NULL;
      END IF;
      PERFORM opengeni_private.open_inbox_item_v1(
        NEW.account_id, NEW.workspace_id, NEW.session_id, v_recipient, 'question',
        NEW.payload #>> '{request,id}',
        coalesce(v_question ->> 'prompt', 'The agent has a question for you'),
        CASE WHEN v_count > 1 THEN (v_count - 1)::text || CASE WHEN v_count = 2
          THEN ' more question' ELSE ' more questions' END ELSE '' END,
        'normal', v_choices);
    WHEN 'session.requiresAction' THEN
      FOR v_approval IN SELECT value FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(NEW.payload -> 'approvals') = 'array'
          THEN NEW.payload -> 'approvals' ELSE '[]'::jsonb END)
      LOOP
        IF v_approval ->> 'id' IS NOT NULL THEN
          PERFORM opengeni_private.open_inbox_item_v1(
            NEW.account_id, NEW.workspace_id, NEW.session_id, v_recipient, 'approval',
            v_approval ->> 'id',
            coalesce(v_approval #>> '{display,toolName}', v_approval ->> 'name', 'A tool call'),
            coalesce(v_approval #>> '{display,title}', v_approval #>> '{display,serverName}', ''),
            'normal');
        END IF;
      END LOOP;
    WHEN 'user.humanInputResponse' THEN
      PERFORM opengeni_private.close_inbox_items_v1(
        NEW.session_id, ARRAY['question'], NEW.payload ->> 'requestId', 'resolved');
    WHEN 'user.approvalDecision' THEN
      PERFORM opengeni_private.close_inbox_items_v1(
        NEW.session_id, ARRAY['approval'], NEW.payload ->> 'approvalId', 'resolved');
    WHEN 'turn.completed', 'turn.failed', 'turn.cancelled', 'turn.superseded' THEN
      -- A finished turn can no longer take an answer or a decision.
      PERFORM opengeni_private.close_inbox_items_v1(
        NEW.session_id, ARRAY['question', 'approval'], NULL, 'resolved');
    WHEN 'goal.paused' THEN
      -- Only an agent's pause waits on the person; a person's own pause does not.
      IF NEW.payload ->> 'actor' = 'agent' THEN
        PERFORM opengeni_private.open_inbox_item_v1(
          NEW.account_id, NEW.workspace_id, NEW.session_id, v_recipient, 'goal_paused',
          'goal', coalesce(nullif(btrim(NEW.payload ->> 'rationale'), ''),
            'The goal is paused until you step in'),
          '', 'normal');
      END IF;
    WHEN 'goal.resumed', 'goal.cleared', 'goal.completed', 'goal.set' THEN
      PERFORM opengeni_private.close_inbox_items_v1(
        NEW.session_id, ARRAY['goal_paused'], 'goal', 'resolved');
    WHEN 'session.notification.posted' THEN
      v_new := opengeni_private.open_inbox_item_v1(
        NEW.account_id, NEW.workspace_id, NEW.session_id, v_recipient, 'notification',
        NEW.payload ->> 'key', NEW.payload ->> 'title', NEW.payload ->> 'body',
        coalesce(NEW.payload ->> 'urgency', 'normal'));
      -- An update in place is silent; only a new notification alerts the phone.
      IF v_new THEN
        PERFORM opengeni_private.enqueue_native_push_v1(
          NEW.session_id, 'agent', NEW.id::text, NEW.payload ->> 'title',
          coalesce(nullif(NEW.payload ->> 'body', ''), NEW.payload ->> 'title'), NEW.type);
      END IF;
    WHEN 'session.notification.withdrawn' THEN
      PERFORM opengeni_private.close_inbox_items_v1(
        NEW.session_id, ARRAY['notification'], NEW.payload ->> 'key', 'withdrawn');
    ELSE
      NULL;
    END CASE;
  EXCEPTION WHEN OTHERS THEN
    -- The inbox must never abort the lifecycle transaction that caused it.
    RAISE WARNING 'inbox projection skipped for event %: %', NEW.id, SQLSTATE;
  END;
  RETURN NULL;
END
$event$;

CREATE OR REPLACE FUNCTION opengeni_private.enqueue_native_push_v1(
  p_session_id uuid, p_rule text, p_dedupe_key text, p_title text, p_body text,
  p_event_type text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $enqueue$
DECLARE
  v_session record;
  v_recipient text;
  v_count integer;
BEGIN
  SELECT session.account_id, session.workspace_id, session.created_by_subject_id,
      session.owner_subject_id, session.title
    INTO v_session
  FROM sessions session
  WHERE session.id = p_session_id
    AND session.account_id = opengeni_private.current_account_id()
    AND session.workspace_id = opengeni_private.current_workspace_id();
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  -- Needs-you and the agent's own notifications reach the owner; replies and
  -- failures only the person who started the session.
  v_recipient := CASE WHEN p_rule IN ('needs_input', 'agent')
    THEN opengeni_private.session_recipient_v1(
      v_session.owner_subject_id, v_session.created_by_subject_id)
    ELSE opengeni_private.session_recipient_v1(NULL, v_session.created_by_subject_id)
  END;
  IF v_recipient IS NULL THEN
    RETURN 0;
  END IF;
  INSERT INTO opengeni_private.native_push_deliveries (auth_session_id, dedupe_key, rule, payload)
  SELECT device.auth_session_id, p_dedupe_key, p_rule, jsonb_strip_nulls(jsonb_build_object(
    'rule', p_rule,
    'eventType', p_event_type,
    'sessionId', p_session_id,
    'workspaceId', v_session.workspace_id,
    'subjectId', device.subject_id,
    'title', left(coalesce(nullif(btrim(p_title), ''), nullif(btrim(v_session.title), '')), 120),
    'body', left(nullif(btrim(p_body), ''), 240)
  ))
  FROM opengeni_private.native_push_devices device
  JOIN auth_sessions auth ON auth.id = device.auth_session_id AND auth.expires_at > now()
  WHERE device.subject_id = v_recipient AND p_rule = ANY (device.rules)
  ON CONFLICT (auth_session_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$enqueue$;

DO $recipient_search_paths$
DECLARE
  target_schema text := current_schema();
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'session_recipient_v1(text,text)',
    'project_inbox_for_session_event_v1()',
    'enqueue_native_push_v1(uuid,text,text,text,text,text)'
  ] LOOP
    EXECUTE format(
      'ALTER FUNCTION opengeni_private.%s SET search_path = pg_catalog, %I, pg_temp',
      signature, target_schema
    );
  END LOOP;
END $recipient_search_paths$;
