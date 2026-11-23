-- deployment-mode: rolling
-- A sub-agent's question held for the agent that started it (1553) reaches
-- the person when delivering its notice leaves that agent idle.
--
-- 1553 releases a held question when the agent's turn that received it ends,
-- or when an agent turn fails or is cancelled before seeing it. A notice
-- delivered to an idle agent that is not woken (its goal is paused, the
-- person paused the chat, or its admission is blocked) waits for a turn that
-- may never come: the question was held, so the person got no inbox item,
-- no push and no list hint, and the sub-agent waited silently.
--
-- This deferred trigger runs when the transaction that added the
-- child_requires_action update commits. If that update is still pending and
-- its session is idle with no turn (a wake would have queued it), the pause's
-- held questions are released to the person exactly as 1553's inbox trigger
-- does (inbox item, push, list hint). The agent still has the notice for its
-- next turn; the first answer wins.
--
-- Rolling: a new trigger and a SECURITY INVOKER trigger function (like
-- 1546's), which the previous release's posture check accepts; it reads and
-- writes only what the delivering transaction can under its own row security
-- and calls the inbox and push routines the runtime may already execute. The
-- previous release never holds a question, so for its deliveries the release
-- finds nothing to do. Failures are warnings and never abort the delivery.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

CREATE OR REPLACE FUNCTION opengeni_private.release_held_child_questions_for_idle_agent_v1()
RETURNS trigger
    LANGUAGE plpgsql VOLATILE SECURITY INVOKER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  v_key text;
  v_child uuid;
  v_turn uuid;
  v_generation integer;
  v_held record;
  v_held_recipient text;
  v_held_sequence integer;
  v_question jsonb;
  v_count integer;
  v_choices jsonb;
BEGIN
  BEGIN
    -- Only a notice no agent turn will see: still pending, and its session
    -- idle without a turn (a registered wake queues the session).
    SELECT notice.dedupe_key INTO v_key
    FROM session_system_updates notice
    JOIN sessions agent
      ON agent.workspace_id = notice.workspace_id AND agent.id = notice.session_id
    WHERE notice.workspace_id = NEW.workspace_id
      AND notice.id = NEW.id
      AND notice.state = 'pending'
      AND agent.status = 'idle'
      AND agent.active_turn_id IS NULL;
    IF v_key IS NULL
      OR v_key !~ '^child-requires-action:[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9]{1,9}$' THEN
      RETURN NULL;
    END IF;
    v_child := split_part(v_key, ':', 2)::uuid;
    v_turn := split_part(v_key, ':', 3)::uuid;
    v_generation := split_part(v_key, ':', 4)::integer;
    FOR v_held IN
      UPDATE session_human_input_requests request
      SET held_for_agent = false, updated_at = now()
      WHERE request.workspace_id = NEW.workspace_id
        AND request.session_id = v_child
        AND request.turn_id = v_turn
        AND request.turn_generation = v_generation
        AND request.status = 'pending'
        AND request.held_for_agent
      RETURNING request.id, request.session_id, request.turn_id, request.questions
    LOOP
      -- The same release as 1553's inbox trigger.
      SELECT opengeni_private.session_person_v1(session.workspace_id, session.id,
          session.owner_subject_id, session.created_by_subject_id)
        INTO v_held_recipient
      FROM sessions session WHERE session.id = v_held.session_id;
      SELECT event.sequence INTO v_held_sequence
      FROM session_events event
      WHERE event.workspace_id = NEW.workspace_id
        AND event.session_id = v_held.session_id
        AND event.turn_id = v_held.turn_id
        AND event.type = 'session.humanInput.requested'
        AND event.payload #>> '{request,id}' = v_held.id::text
      ORDER BY event.sequence DESC
      LIMIT 1;
      v_question := v_held.questions -> 0;
      v_count := greatest(jsonb_array_length(v_held.questions), 1);
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
      IF v_held_recipient IS NOT NULL THEN
        PERFORM opengeni_private.open_inbox_item_v1(
          NEW.account_id, NEW.workspace_id, v_held.session_id, v_held_recipient, 'question',
          v_held.id::text,
          coalesce(v_question ->> 'prompt', 'The agent has a question for you'),
          CASE WHEN v_count > 1 THEN (v_count - 1)::text || CASE WHEN v_count = 2
            THEN ' more question' ELSE ' more questions' END ELSE '' END,
          'normal', v_choices);
        IF v_held_sequence IS NOT NULL THEN
          PERFORM opengeni_private.mark_inbox_item_event_v1(
            v_held.session_id, 'question', v_held.id::text, v_held_sequence);
        END IF;
      END IF;
      PERFORM opengeni_private.enqueue_native_push_v2(
        v_held.session_id, 'needs_input', 'held-question:' || v_held.id::text, NULL,
        left(coalesce(v_question ->> 'prompt', 'The agent has a question for you.'), 240),
        'session.humanInput.requested',
        jsonb_strip_nulls(jsonb_build_object('sequence', v_held_sequence)));
      PERFORM pg_notify('opengeni_session_lists', json_build_object(
        'schema', TG_TABLE_SCHEMA, 'workspaceId', NEW.workspace_id,
        'sessionId', v_held.session_id, 'subjectId', NULL, 'all', false)::text);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    -- The child's own chat still shows the question.
    RAISE WARNING 'held question release skipped for update %: %', NEW.id, SQLSTATE;
  END;
  RETURN NULL;
END
$$;

DO $pin$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.release_held_child_questions_for_idle_agent_v1() SET search_path = pg_catalog, %I, pg_temp',
    current_schema()
  );
END
$pin$;

-- Trigger functions fire without EXECUTE; nobody calls this one directly.
REVOKE ALL ON FUNCTION opengeni_private.release_held_child_questions_for_idle_agent_v1() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER session_system_updates_release_held_child_questions_v1
  AFTER INSERT ON session_system_updates
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.kind = 'child_requires_action')
  EXECUTE FUNCTION opengeni_private.release_held_child_questions_for_idle_agent_v1();
