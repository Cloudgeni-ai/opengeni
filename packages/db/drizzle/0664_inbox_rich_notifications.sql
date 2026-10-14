-- deployment-mode: rolling
-- Richer agent notifications and landing on the moment they were sent. An
-- agent's notification can carry a subtitle, a longer message, up to four
-- label/value facts and one outside link; every inbox item remembers the
-- session event that opened it, so opening the item (or its phone
-- notification) lands on that point in the session. Pushes carry the same
-- subtitle, facts, urgency and event sequence.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE opengeni_private.inbox_items
  ADD COLUMN subtitle text NOT NULL DEFAULT '' CHECK (char_length(subtitle) <= 120),
  ADD COLUMN facts jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(facts) = 'array' AND jsonb_array_length(facts) <= 4),
  ADD COLUMN link jsonb CHECK (link IS NULL OR jsonb_typeof(link) = 'object'),
  ADD COLUMN event_sequence integer CHECK (event_sequence IS NULL OR event_sequence > 0);

-- A notification's message may now run to a short paragraph or a few bullets.
ALTER TABLE opengeni_private.inbox_items DROP CONSTRAINT inbox_items_body_check;
ALTER TABLE opengeni_private.inbox_items
  ADD CONSTRAINT inbox_items_body_check CHECK (char_length(body) <= 2000) NOT VALID;
ALTER TABLE opengeni_private.inbox_items VALIDATE CONSTRAINT inbox_items_body_check;

CREATE OR REPLACE FUNCTION opengeni_private.open_inbox_item_v1(
  p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_recipient text,
  p_kind text, p_source_key text, p_title text, p_body text, p_urgency text,
  p_choices jsonb DEFAULT '[]'::jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $open$
DECLARE
  v_previous text;
BEGIN
  SELECT item.status INTO v_previous FROM opengeni_private.inbox_items item
  WHERE item.session_id = p_session_id AND item.kind = p_kind AND item.source_key = p_source_key;
  INSERT INTO opengeni_private.inbox_items AS item (
    account_id, workspace_id, session_id, recipient_subject_id, kind, source_key,
    title, body, urgency, choices
  ) VALUES (
    p_account_id, p_workspace_id, p_session_id, p_recipient, p_kind, p_source_key,
    left(coalesce(nullif(btrim(p_title), ''), 'Needs you'), 200),
    left(coalesce(btrim(p_body), ''), 2000),
    coalesce(p_urgency, 'normal'),
    coalesce(p_choices, '[]'::jsonb)
  )
  ON CONFLICT (session_id, kind, source_key) DO UPDATE SET
    title = excluded.title,
    body = excluded.body,
    choices = excluded.choices,
    urgency = excluded.urgency,
    status = CASE WHEN item.status IN ('resolved', 'withdrawn') THEN 'open' ELSE item.status END,
    resolved_at = CASE WHEN item.status IN ('resolved', 'withdrawn') THEN NULL ELSE item.resolved_at END,
    content_version = item.content_version + 1,
    updated_at = now();
  RETURN v_previous IS NULL OR v_previous IN ('resolved', 'withdrawn');
END
$open$;

-- The session event an item points at (the latest one that opened or updated it).
CREATE FUNCTION opengeni_private.mark_inbox_item_event_v1(
  p_session_id uuid, p_kind text, p_source_key text, p_sequence integer
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $mark$
  UPDATE opengeni_private.inbox_items item SET event_sequence = p_sequence
  WHERE item.session_id = p_session_id AND item.kind = p_kind
    AND item.source_key = p_source_key
$mark$;

CREATE FUNCTION opengeni_private.list_inbox_items_v2(p_account_id uuid, p_subject_id text)
RETURNS TABLE (
  id uuid, workspace_id uuid, session_id uuid, kind text,
  source_key text, title text, subtitle text, body text, facts jsonb, link jsonb,
  event_sequence integer, choices jsonb, urgency text, status text, unread boolean,
  snoozed_until timestamptz, created_at timestamptz, updated_at timestamptz,
  resolved_at timestamptz
)
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $list$
  SELECT item.id, item.workspace_id, item.session_id, item.kind,
    item.source_key, item.title, item.subtitle, item.body, item.facts, item.link,
    item.event_sequence, item.choices, item.urgency, item.status,
    item.seen_version < item.content_version, item.snoozed_until, item.created_at,
    item.updated_at, item.resolved_at
  FROM opengeni_private.inbox_items item
  WHERE item.account_id = p_account_id
    AND item.recipient_subject_id = p_subject_id
    AND item.status = 'open'
  ORDER BY item.updated_at DESC
  LIMIT 500
$list$;

-- Push with extra display fields (subtitle, facts, urgency, the event's
-- sequence) merged into the delivery payload. v1 stays for older callers.
CREATE FUNCTION opengeni_private.enqueue_native_push_v2(
  p_session_id uuid, p_rule text, p_dedupe_key text, p_title text, p_body text,
  p_event_type text, p_extra jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $enqueue$
DECLARE
  v_session record;
  v_recipient text;
  v_count integer;
BEGIN
  SELECT session.id, session.account_id, session.workspace_id, session.created_by_subject_id,
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
    THEN opengeni_private.session_person_v1(v_session.workspace_id, v_session.id,
      v_session.owner_subject_id, v_session.created_by_subject_id)
    ELSE opengeni_private.session_recipient_v1(NULL, v_session.created_by_subject_id)
  END;
  IF v_recipient IS NULL THEN
    RETURN 0;
  END IF;
  INSERT INTO opengeni_private.native_push_deliveries (auth_session_id, dedupe_key, rule, payload)
  SELECT device.auth_session_id, p_dedupe_key, p_rule,
    jsonb_strip_nulls(jsonb_build_object(
      'rule', p_rule,
      'eventType', p_event_type,
      'sessionId', p_session_id,
      'workspaceId', v_session.workspace_id,
      'subjectId', device.subject_id,
      'title', left(coalesce(nullif(btrim(p_title), ''), nullif(btrim(v_session.title), '')), 120),
      'body', left(nullif(btrim(p_body), ''), 1000)
    )) || coalesce(p_extra, '{}'::jsonb)
  FROM opengeni_private.native_push_devices device
  JOIN auth_sessions auth ON auth.id = device.auth_session_id AND auth.expires_at > now()
  WHERE device.subject_id = v_recipient AND p_rule = ANY (device.rules)
  ON CONFLICT (auth_session_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$enqueue$;

CREATE OR REPLACE FUNCTION opengeni_private.enqueue_native_push_v1(
  p_session_id uuid, p_rule text, p_dedupe_key text, p_title text, p_body text,
  p_event_type text
) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $enqueue$
  SELECT opengeni_private.enqueue_native_push_v2(
    p_session_id, p_rule, p_dedupe_key, p_title, left(p_body, 240), p_event_type, '{}'::jsonb)
$enqueue$;

-- Needs-you, reply and failure pushes also carry the event's sequence.
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
    IF v_rule IS NOT NULL AND NEW.session_id IS NOT NULL THEN
      PERFORM opengeni_private.enqueue_native_push_v2(
        NEW.session_id, v_rule, NEW.id::text, NULL, left(v_body, 240), NEW.type,
        jsonb_build_object('sequence', NEW.sequence));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- A notification must never abort the lifecycle transaction that caused it.
    RAISE WARNING 'native push enqueue skipped for event %: %', NEW.id, SQLSTATE;
  END;
  RETURN NULL;
END
$event$;

CREATE OR REPLACE FUNCTION opengeni_private.project_inbox_for_session_event_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $event$
DECLARE
  v_recipient text;
  v_question jsonb;
  v_count integer;
  v_approval jsonb;
  v_new boolean;
  v_choices jsonb;
  v_sub_agent boolean;
BEGIN
  BEGIN
    SELECT opengeni_private.session_person_v1(session.workspace_id, session.id,
        session.owner_subject_id, session.created_by_subject_id),
      session.parent_session_id IS NOT NULL
      INTO v_recipient, v_sub_agent
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
      PERFORM opengeni_private.mark_inbox_item_event_v1(
        NEW.session_id, 'question', NEW.payload #>> '{request,id}', NEW.sequence);
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
          PERFORM opengeni_private.mark_inbox_item_event_v1(
            NEW.session_id, 'approval', v_approval ->> 'id', NEW.sequence);
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
      -- Only an agent's pause in a top-level session waits on the person; a
      -- person's own pause does not, and a sub-agent's waits on its parent.
      -- ...and only for people who asked to see paused goals in their inbox.
      IF NEW.payload ->> 'actor' = 'agent' AND NOT coalesce(v_sub_agent, false)
        AND EXISTS (
          SELECT 1 FROM opengeni_private.inbox_settings settings
          WHERE settings.account_id = NEW.account_id
            AND settings.subject_id = v_recipient
            AND settings.paused_goals
        ) THEN
        PERFORM opengeni_private.open_inbox_item_v1(
          NEW.account_id, NEW.workspace_id, NEW.session_id, v_recipient, 'goal_paused',
          'goal', coalesce(nullif(btrim(NEW.payload ->> 'rationale'), ''),
            'The goal is paused until you step in'),
          '', 'normal');
        PERFORM opengeni_private.mark_inbox_item_event_v1(
          NEW.session_id, 'goal_paused', 'goal', NEW.sequence);
      END IF;
    WHEN 'goal.resumed', 'goal.cleared', 'goal.completed', 'goal.set' THEN
      PERFORM opengeni_private.close_inbox_items_v1(
        NEW.session_id, ARRAY['goal_paused'], 'goal', 'resolved');
    WHEN 'session.notification.posted' THEN
      v_new := opengeni_private.open_inbox_item_v1(
        NEW.account_id, NEW.workspace_id, NEW.session_id, v_recipient, 'notification',
        NEW.payload ->> 'key', NEW.payload ->> 'title', NEW.payload ->> 'body',
        coalesce(NEW.payload ->> 'urgency', 'normal'));
      UPDATE opengeni_private.inbox_items item SET
        subtitle = left(coalesce(btrim(NEW.payload ->> 'subtitle'), ''), 120),
        facts = CASE WHEN jsonb_typeof(NEW.payload -> 'facts') = 'array'
          AND jsonb_array_length(NEW.payload -> 'facts') <= 4
          THEN NEW.payload -> 'facts' ELSE '[]'::jsonb END,
        link = CASE WHEN jsonb_typeof(NEW.payload -> 'link') = 'object'
          THEN NEW.payload -> 'link' END,
        event_sequence = NEW.sequence
      WHERE item.session_id = NEW.session_id AND item.kind = 'notification'
        AND item.source_key = NEW.payload ->> 'key';
      -- An update in place is silent; only a new notification alerts the phone.
      IF v_new THEN
        PERFORM opengeni_private.enqueue_native_push_v2(
          NEW.session_id, 'agent', NEW.id::text, NEW.payload ->> 'title',
          coalesce(nullif(NEW.payload ->> 'body', ''), NEW.payload ->> 'title'), NEW.type,
          jsonb_strip_nulls(jsonb_build_object(
            'subtitle', nullif(btrim(NEW.payload ->> 'subtitle'), ''),
            'facts', CASE WHEN jsonb_typeof(NEW.payload -> 'facts') = 'array'
              THEN NEW.payload -> 'facts' END,
            'urgency', NEW.payload ->> 'urgency',
            'sequence', NEW.sequence)));
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

DO $rich_notifications$
DECLARE
  target_schema text := current_schema();
  signature text;
  target_role record;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'open_inbox_item_v1(uuid,uuid,uuid,text,text,text,text,text,text,jsonb)',
    'mark_inbox_item_event_v1(uuid,text,text,integer)',
    'list_inbox_items_v2(uuid,text)',
    'enqueue_native_push_v2(uuid,text,text,text,text,text,jsonb)',
    'enqueue_native_push_v1(uuid,text,text,text,text,text)',
    'enqueue_native_push_for_session_event_v1()',
    'project_inbox_for_session_event_v1()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.%s FROM PUBLIC', signature);
    EXECUTE format(
      'ALTER FUNCTION opengeni_private.%s SET search_path = pg_catalog, %I, pg_temp',
      signature, target_schema
    );
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.mark_inbox_item_event_v1(uuid,text,text,integer),
      opengeni_private.list_inbox_items_v2(uuid,text),
      opengeni_private.enqueue_native_push_v2(uuid,text,text,text,text,text,jsonb)
      TO opengeni_app;
  END IF;
  -- Rolling custom-role compatibility: whoever may write session events (and
  -- so fire the triggers) gets the triggers' new helpers too.
  FOR target_role IN
    SELECT DISTINCT roles.rolname
    FROM pg_catalog.pg_proc procedure
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) acl
    JOIN pg_catalog.pg_roles roles ON roles.oid = acl.grantee
    WHERE namespace.nspname = 'opengeni_private'
      AND procedure.proname = 'enqueue_native_push_for_session_event_v1'
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee <> procedure.proowner
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.mark_inbox_item_event_v1(uuid,text,text,integer), opengeni_private.enqueue_native_push_v2(uuid,text,text,text,text,text,jsonb) TO %I',
      target_role.rolname
    );
  END LOOP;
END $rich_notifications$;
