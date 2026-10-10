-- deployment-mode: rolling
-- An agent can notify another member of its session's workspace, not only the
-- person it works for, when that member allows it. Each person decides per
-- workspace, off by default. The item lands in the recipient's inbox with who
-- it came from (the person the sending session works for), and their phone
-- alerts as for their own agents' notifications. Inbox items become per
-- recipient, so one key can reach the owner and a teammate separately.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE opengeni_private.inbox_member_notify_optins (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, subject_id)
);
CREATE INDEX inbox_member_notify_optins_person_idx
  ON opengeni_private.inbox_member_notify_optins (account_id, subject_id);

ALTER TABLE opengeni_private.inbox_member_notify_optins ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.inbox_member_notify_optins FORCE ROW LEVEL SECURITY;
CREATE POLICY inbox_member_notify_optins_owner ON opengeni_private.inbox_member_notify_optins
  USING (current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner) FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'opengeni_private.inbox_member_notify_optins'::regclass))
  WITH CHECK (current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner) FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'opengeni_private.inbox_member_notify_optins'::regclass));
REVOKE ALL ON TABLE opengeni_private.inbox_member_notify_optins FROM PUBLIC;

-- Who a notification came from, when another member's agent sent it.
ALTER TABLE opengeni_private.inbox_items
  ADD COLUMN sender_subject_id text
    CHECK (sender_subject_id IS NULL OR char_length(sender_subject_id) BETWEEN 1 AND 300),
  ADD COLUMN sender_label text
    CHECK (sender_label IS NULL OR char_length(sender_label) BETWEEN 1 AND 200);

-- One item per recipient: the same key may reach the owner and a teammate.
ALTER TABLE opengeni_private.inbox_items
  ADD CONSTRAINT inbox_items_session_kind_source_recipient_key
  UNIQUE (session_id, kind, source_key, recipient_subject_id);
ALTER TABLE opengeni_private.inbox_items
  DROP CONSTRAINT inbox_items_session_id_kind_source_key_key;

-- Whether this person lets other members' agents notify them in this workspace.
CREATE FUNCTION opengeni_private.member_notifications_allowed_v1(
  p_workspace_id uuid, p_subject_id text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $allowed$
  SELECT EXISTS (
    SELECT 1 FROM opengeni_private.inbox_member_notify_optins optin
    WHERE optin.workspace_id = p_workspace_id AND optin.subject_id = p_subject_id
  )
$allowed$;

-- Turn it on or off for this person in this workspace of this organization.
CREATE FUNCTION opengeni_private.set_member_notifications_allowed_v1(
  p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_allowed boolean
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $set_allowed$
BEGIN
  IF p_allowed THEN
    INSERT INTO opengeni_private.inbox_member_notify_optins (account_id, workspace_id, subject_id)
    VALUES (p_account_id, p_workspace_id, p_subject_id)
    ON CONFLICT (workspace_id, subject_id) DO NOTHING;
  ELSE
    DELETE FROM opengeni_private.inbox_member_notify_optins optin
    WHERE optin.workspace_id = p_workspace_id AND optin.subject_id = p_subject_id;
  END IF;
  RETURN p_allowed;
END
$set_allowed$;

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
  WHERE item.session_id = p_session_id AND item.kind = p_kind
    AND item.source_key = p_source_key AND item.recipient_subject_id = p_recipient;
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
  ON CONFLICT (session_id, kind, source_key, recipient_subject_id) DO UPDATE SET
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

CREATE FUNCTION opengeni_private.list_inbox_items_v3(p_account_id uuid, p_subject_id text)
RETURNS TABLE (
  id uuid, workspace_id uuid, session_id uuid, kind text,
  source_key text, title text, subtitle text, body text, facts jsonb, link jsonb,
  event_sequence integer, choices jsonb, urgency text, status text, unread boolean,
  snoozed_until timestamptz, created_at timestamptz, updated_at timestamptz,
  resolved_at timestamptz, sender_subject_id text, sender_label text
)
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $list$
  SELECT item.id, item.workspace_id, item.session_id, item.kind,
    item.source_key, item.title, item.subtitle, item.body, item.facts, item.link,
    item.event_sequence, item.choices, item.urgency, item.status,
    item.seen_version < item.content_version, item.snoozed_until, item.created_at,
    item.updated_at, item.resolved_at, item.sender_subject_id, item.sender_label
  FROM opengeni_private.inbox_items item
  WHERE item.account_id = p_account_id
    AND item.recipient_subject_id = p_subject_id
    AND item.status = 'open'
  ORDER BY item.updated_at DESC
  LIMIT 500
$list$;

-- Push to an explicit person (another member) or, when p_recipient is null,
-- to whom the rule names for the session, as v2 does. Without p_link_session
-- the push carries no session, so tapping it opens the app instead.
CREATE FUNCTION opengeni_private.enqueue_native_push_v3(
  p_session_id uuid, p_rule text, p_dedupe_key text, p_title text, p_body text,
  p_event_type text, p_extra jsonb, p_recipient text, p_link_session boolean
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
  v_recipient := CASE
    WHEN p_recipient IS NOT NULL THEN p_recipient
    WHEN p_rule IN ('needs_input', 'agent')
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
      'sessionId', CASE WHEN p_link_session THEN p_session_id END,
      'workspaceId', v_session.workspace_id,
      'subjectId', device.subject_id,
      'title', left(coalesce(nullif(btrim(p_title), ''),
        CASE WHEN p_link_session THEN nullif(btrim(v_session.title), '') END), 120),
      'body', left(nullif(btrim(p_body), ''), 1000)
    ) || coalesce(p_extra, '{}'::jsonb))
  FROM opengeni_private.native_push_devices device
  JOIN auth_sessions auth ON auth.id = device.auth_session_id AND auth.expires_at > now()
  WHERE device.subject_id = v_recipient AND p_rule = ANY (device.rules)
  ON CONFLICT (auth_session_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$enqueue$;

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
  v_reply text;
  v_reply_title text;
  v_reply_sequence integer;
  v_target text;
  v_sender_label text;
  v_shared boolean;
BEGIN
  BEGIN
    SELECT opengeni_private.session_person_v1(session.workspace_id, session.id,
        session.owner_subject_id, session.created_by_subject_id),
      session.parent_session_id IS NOT NULL,
      session.visibility = 'workspace_shared'
      INTO v_recipient, v_sub_agent, v_shared
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
      -- For people who keep replies in their inbox, a finished reply in a
      -- top-level session refreshes that session's one reply item. It stays,
      -- read or not, until the person clears it; a later reply brings a
      -- cleared one back.
      IF NEW.type = 'turn.completed' AND NEW.turn_id IS NOT NULL
        AND NOT coalesce(v_sub_agent, false)
        AND opengeni_private.session_hands_back_v1(NEW.session_id, NEW.turn_id)
        AND NOT opengeni_private.session_replies_muted_v1(NEW.session_id)
        AND EXISTS (
          SELECT 1 FROM opengeni_private.inbox_settings settings
          WHERE settings.account_id = NEW.account_id
            AND settings.subject_id = v_recipient
            AND settings.replies
        ) THEN
        SELECT event.payload ->> 'text', event.sequence INTO v_reply, v_reply_sequence
        FROM session_events event
        WHERE event.session_id = NEW.session_id
          AND event.type = 'agent.message.completed'
          AND event.turn_id = NEW.turn_id
          AND event.sequence < NEW.sequence
          AND nullif(btrim(event.payload ->> 'text'), '') IS NOT NULL
        ORDER BY event.sequence DESC
        LIMIT 1;
        IF v_reply IS NOT NULL THEN
          v_reply := regexp_replace(v_reply, '^\s+|\s+$', '', 'g');
          v_reply_title := btrim(regexp_replace(
            split_part(v_reply, E'\n', 1), '^[#>*\-\s]+|[*_`]', '', 'g'));
          UPDATE opengeni_private.inbox_items item SET status = 'resolved'
          WHERE item.session_id = NEW.session_id AND item.kind = 'reply'
            AND item.status = 'dismissed';
          PERFORM opengeni_private.open_inbox_item_v1(
            NEW.account_id, NEW.workspace_id, NEW.session_id, v_recipient, 'reply', 'reply',
            left(coalesce(nullif(v_reply_title, ''), 'The agent replied'), 160),
            left(regexp_replace(substr(v_reply, char_length(split_part(v_reply, E'\n', 1)) + 1),
              '^\s+|\s+$', '', 'g'), 600),
            'normal');
          PERFORM opengeni_private.mark_inbox_item_event_v1(
            NEW.session_id, 'reply', 'reply', v_reply_sequence);
        END IF;
      END IF;
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
      v_target := coalesce(nullif(NEW.payload ->> 'recipientSubjectId', ''), v_recipient);
      IF v_target <> v_recipient THEN
        -- Another member: only while they belong to this workspace and allow it.
        IF NOT EXISTS (
            SELECT 1 FROM workspace_memberships membership
            WHERE membership.workspace_id = NEW.workspace_id
              AND membership.subject_id = v_target)
          OR NOT opengeni_private.member_notifications_allowed_v1(NEW.workspace_id, v_target)
        THEN
          RETURN NULL;
        END IF;
        v_sender_label := left(coalesce(nullif(btrim(NEW.payload #>> '{sender,label}'), ''),
          'A teammate'), 200);
      END IF;
      v_new := opengeni_private.open_inbox_item_v1(
        NEW.account_id, NEW.workspace_id, NEW.session_id, v_target, 'notification',
        NEW.payload ->> 'key', NEW.payload ->> 'title', NEW.payload ->> 'body',
        coalesce(NEW.payload ->> 'urgency', 'normal'));
      UPDATE opengeni_private.inbox_items item SET
        subtitle = left(coalesce(btrim(NEW.payload ->> 'subtitle'), ''), 120),
        facts = CASE WHEN jsonb_typeof(NEW.payload -> 'facts') = 'array'
          AND jsonb_array_length(NEW.payload -> 'facts') <= 4
          THEN NEW.payload -> 'facts' ELSE '[]'::jsonb END,
        link = CASE WHEN jsonb_typeof(NEW.payload -> 'link') = 'object'
          THEN NEW.payload -> 'link' END,
        event_sequence = NEW.sequence,
        sender_subject_id = CASE WHEN v_target <> v_recipient THEN v_recipient END,
        sender_label = v_sender_label
      WHERE item.session_id = NEW.session_id AND item.kind = 'notification'
        AND item.source_key = NEW.payload ->> 'key'
        AND item.recipient_subject_id = v_target;
      -- An update in place is silent; only a new notification alerts the phone.
      IF v_new THEN
        PERFORM opengeni_private.enqueue_native_push_v3(
          NEW.session_id, 'agent',
          CASE WHEN v_target = v_recipient THEN NEW.id::text
            ELSE NEW.id::text || ':' || v_target END,
          NEW.payload ->> 'title',
          coalesce(nullif(NEW.payload ->> 'body', ''), NEW.payload ->> 'title'), NEW.type,
          jsonb_strip_nulls(jsonb_build_object(
            'subtitle', CASE WHEN v_target = v_recipient
              THEN nullif(btrim(NEW.payload ->> 'subtitle'), '')
              ELSE left('From ' || v_sender_label || coalesce(
                ' · ' || nullif(btrim(NEW.payload ->> 'subtitle'), ''), ''), 160) END,
            'facts', CASE WHEN jsonb_typeof(NEW.payload -> 'facts') = 'array'
              THEN NEW.payload -> 'facts' END,
            'urgency', NEW.payload ->> 'urgency',
            'sequence', CASE WHEN v_target = v_recipient OR coalesce(v_shared, false)
              THEN NEW.sequence END)),
          v_target,
          -- Another member's private session would not open for them.
          v_target = v_recipient OR coalesce(v_shared, false));
      END IF;
    WHEN 'session.notification.withdrawn' THEN
      IF nullif(NEW.payload ->> 'recipientSubjectId', '') IS NULL THEN
        PERFORM opengeni_private.close_inbox_items_v1(
          NEW.session_id, ARRAY['notification'], NEW.payload ->> 'key', 'withdrawn');
      ELSE
        UPDATE opengeni_private.inbox_items item
        SET status = 'withdrawn', resolved_at = now(), updated_at = now()
        WHERE item.session_id = NEW.session_id AND item.kind = 'notification'
          AND item.source_key = NEW.payload ->> 'key'
          AND item.recipient_subject_id = NEW.payload ->> 'recipientSubjectId'
          AND item.status IN ('open', 'dismissed');
      END IF;
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

DO $inbox_member_notifications$
DECLARE
  target_schema text := current_schema();
  target_role record;
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'member_notifications_allowed_v1(uuid,text)',
    'set_member_notifications_allowed_v1(uuid,uuid,text,boolean)',
    'open_inbox_item_v1(uuid,uuid,uuid,text,text,text,text,text,text,jsonb)',
    'list_inbox_items_v3(uuid,text)',
    'enqueue_native_push_v3(uuid,text,text,text,text,text,jsonb,text,boolean)',
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
      opengeni_private.member_notifications_allowed_v1(uuid,text),
      opengeni_private.set_member_notifications_allowed_v1(uuid,uuid,text,boolean),
      opengeni_private.list_inbox_items_v3(uuid,text),
      opengeni_private.enqueue_native_push_v3(uuid,text,text,text,text,text,jsonb,text,boolean)
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
      AND procedure.proname = 'project_inbox_for_session_event_v1'
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee <> procedure.proowner
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.member_notifications_allowed_v1(uuid,text), opengeni_private.enqueue_native_push_v3(uuid,text,text,text,text,text,jsonb,text,boolean) TO %I',
      target_role.rolname
    );
  END LOOP;
END $inbox_member_notifications$;
