-- deployment-mode: rolling
-- An approval whose tool's MCP server asks the person a question mid-call
-- (1100) reads as that question wherever approvals reach the person. Its
-- inbox item is titled with the server's question, its body names the call,
-- and it records which server asks, whether the question has fields to fill
-- in (or is too long to answer from the title), and which of the call's
-- questions it is (the round a decision must name). A server that asks again reopens the item with the new question.
-- Its phone push says what the server asks and carries serverQuestionKind,
-- so the push offers no lock-screen Approve: the question is answered where
-- it is shown.
--
-- Both trigger functions are the 1067 versions plus the server question;
-- approvals without one project exactly as before. Same signatures, so
-- triggers and grants are kept. The new column is nullable without default
-- (catalog-only); the previous release reads list_inbox_items_v3, which keeps
-- working.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE opengeni_private.inbox_items
  ADD COLUMN IF NOT EXISTS server_question jsonb;
COMMENT ON COLUMN opengeni_private.inbox_items.server_question IS
  'For an approval its MCP server asks a question about: {server, kind, round}. kind is confirm when the item title shows the whole question (one question, no fields, a message of at most 200 characters) so it can be answered in one tap, else form; round is the question the item shows. Null otherwise.';

-- The server question on one session.requiresAction approval entry, or null:
-- {server, kind, round}.
CREATE OR REPLACE FUNCTION opengeni_private.inbox_server_question_v1(p_approval jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_approval #> '{elicitation,requests}') = 'array'
      AND jsonb_array_length(p_approval #> '{elicitation,requests}') > 0
      AND jsonb_typeof(p_approval #> '{elicitation,round}') = 'number'
    THEN jsonb_build_object(
      'server', left(coalesce(nullif(btrim(p_approval #>> '{elicitation,server}'), ''),
        'The server'), 256),
      -- confirm only when the item's title shows the whole question: one
      -- question, nothing to fill in, and a message that fits the title.
      'kind', CASE WHEN jsonb_array_length(p_approval #> '{elicitation,requests}') = 1
          AND coalesce(p_approval #> '{elicitation,requests,0,requestedSchema,properties}',
            '{}'::jsonb) = '{}'::jsonb
          AND char_length(btrim(coalesce(p_approval #>> '{elicitation,requests,0,message}', '')))
            BETWEEN 1 AND 200
        THEN 'confirm' ELSE 'form' END,
      'round', p_approval #> '{elicitation,round}')
  END
$$;

-- What the server asks: its first question's message, or null.
CREATE OR REPLACE FUNCTION opengeni_private.inbox_server_question_text_v1(p_approval jsonb)
    RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $$
  SELECT CASE WHEN opengeni_private.inbox_server_question_v1(p_approval) IS NOT NULL
    THEN left(coalesce(nullif(btrim(p_approval #>> '{elicitation,requests,0,message}'), ''),
      'A question about this call'), 200)
  END
$$;

REVOKE ALL ON FUNCTION opengeni_private.inbox_server_question_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.inbox_server_question_text_v1(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION opengeni_private.enqueue_native_push_for_session_event_v1() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  v_rule text;
  v_body text;
  v_title text;
  v_source text;
  v_question text;
  v_question_kind text;
BEGIN
  BEGIN
    IF NEW.type = 'session.requiresAction' THEN
      v_title := opengeni_private.inbox_approval_title_v1(
        coalesce(NEW.payload #> '{approvals,0}', '{}'::jsonb));
      v_source := nullif(opengeni_private.inbox_approval_source_v1(
        coalesce(NEW.payload #> '{approvals,0}', '{}'::jsonb)), '');
      v_question := opengeni_private.inbox_server_question_text_v1(
        NEW.payload #> '{approvals,0}');
      v_question_kind := (SELECT max(opengeni_private.inbox_server_question_v1(approval.value)
          ->> 'kind')
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.payload -> 'approvals') = 'array'
          THEN NEW.payload -> 'approvals' ELSE '[]'::jsonb END) approval);
    END IF;
    v_rule := CASE NEW.type
      WHEN 'session.humanInput.requested' THEN 'needs_input'
      WHEN 'session.requiresAction' THEN 'needs_input'
      WHEN 'turn.completed' THEN 'reply_ready'
      WHEN 'turn.failed' THEN 'failed'
    END;
    v_body := CASE NEW.type
      WHEN 'session.humanInput.requested' THEN coalesce(
        NEW.payload #>> '{request,questions,0,prompt}', 'The agent has a question for you.')
      -- A title that already asks ("Invite … to your organization?") stands alone.
      -- An MCP server's question about the call reads as that question.
      WHEN 'session.requiresAction' THEN CASE
        WHEN v_question IS NOT NULL THEN coalesce(
          opengeni_private.inbox_server_question_v1(NEW.payload #> '{approvals,0}') ->> 'server',
          'The server') || ' asks: ' || v_question
        WHEN v_title LIKE '%?'
        THEN v_title || coalesce(' (' || v_source || ')', '')
        ELSE 'Needs your approval: ' || v_title || coalesce(' (' || v_source || ')', '') END
      WHEN 'turn.completed' THEN 'The agent replied.'
      WHEN 'turn.failed' THEN 'The agent ran into a problem. Open the session to retry.'
    END;
    IF v_rule IN ('reply_ready', 'failed') AND EXISTS (
      SELECT 1 FROM sessions session
      WHERE session.id = NEW.session_id AND session.parent_session_id IS NOT NULL
    ) THEN
      v_rule := NULL;
    END IF;
    -- A person who muted this session hears no replies from it.
    IF v_rule = 'reply_ready' AND opengeni_private.session_replies_muted_v1(NEW.session_id) THEN
      v_rule := NULL;
    END IF;
    IF v_rule = 'reply_ready' AND NEW.turn_id IS NOT NULL
      AND NOT opengeni_private.session_hands_back_v1(NEW.session_id, NEW.turn_id) THEN
      v_rule := NULL;
    END IF;
    IF v_rule IS NOT NULL AND NEW.session_id IS NOT NULL THEN
      PERFORM opengeni_private.enqueue_native_push_v2(
        NEW.session_id, v_rule, NEW.id::text, NULL, left(v_body, 240), NEW.type,
        jsonb_build_object('sequence', NEW.sequence)
          -- A server question is answered in the app, where it is shown,
          -- never on the lock screen.
          || CASE WHEN v_question_kind IS NOT NULL
            THEN jsonb_build_object('serverQuestionKind', v_question_kind)
            ELSE '{}'::jsonb END);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'native push enqueue skipped for event %: %', NEW.id, SQLSTATE;
  END;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION opengeni_private.project_inbox_for_session_event_v1() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $_$
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
  v_approval_title text;
  v_approval_source text;
  v_server_question jsonb;
BEGIN
  BEGIN
    SELECT opengeni_private.session_person_v1(session.workspace_id, session.id,
        session.owner_subject_id, session.created_by_subject_id),
      session.parent_session_id IS NOT NULL,
      session.visibility = 'workspace_shared'
      INTO v_recipient, v_sub_agent, v_shared
    FROM sessions session WHERE session.id = NEW.session_id;
    IF NEW.type IN ('session.notification.posted', 'session.notification.withdrawn')
      AND NEW.turn_id IS NOT NULL THEN
      SELECT opengeni_private.session_person_v1(NEW.workspace_id, NULL,
        turn.initiating_human_subject_id, turn.initiating_human_subject_id)
      INTO v_recipient FROM session_turns turn
      WHERE turn.id = NEW.turn_id AND turn.session_id = NEW.session_id
        AND turn.workspace_id = NEW.workspace_id;
    END IF;
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
          v_approval_title := opengeni_private.inbox_approval_title_v1(v_approval);
          v_approval_source := opengeni_private.inbox_approval_source_v1(v_approval);
          v_server_question := opengeni_private.inbox_server_question_v1(v_approval);
          IF v_server_question IS NOT NULL THEN
            -- The tool's MCP server asks the person mid-call: the item is
            -- its question, under the call it belongs to. A question asked
            -- again after an answer has no display details; it keeps the
            -- call's title the item already shows.
            IF jsonb_typeof(v_approval -> 'display') IS DISTINCT FROM 'object' THEN
              SELECT coalesce(nullif(item.body, ''), v_approval_title) INTO v_approval_source
              FROM opengeni_private.inbox_items item
              WHERE item.session_id = NEW.session_id AND item.kind = 'approval'
                AND item.source_key = v_approval ->> 'id'
                AND item.recipient_subject_id = v_recipient;
              IF NOT FOUND THEN
                v_approval_source := v_approval_title;
              END IF;
            ELSE
              v_approval_source := v_approval_title;
            END IF;
            v_approval_title := opengeni_private.inbox_server_question_text_v1(v_approval);
          -- A later pause of the same turn names its remaining approvals
          -- without display details; keep what the open item already says.
          ELSIF jsonb_typeof(v_approval -> 'display') IS DISTINCT FROM 'object' THEN
            SELECT item.title, item.body INTO v_approval_title, v_approval_source
            FROM opengeni_private.inbox_items item
            WHERE item.session_id = NEW.session_id AND item.kind = 'approval'
              AND item.source_key = v_approval ->> 'id'
              AND item.recipient_subject_id = v_recipient
              AND item.status IN ('open', 'dismissed');
            IF NOT FOUND THEN
              v_approval_title := opengeni_private.inbox_approval_title_v1(v_approval);
              v_approval_source := opengeni_private.inbox_approval_source_v1(v_approval);
            END IF;
          END IF;
          PERFORM opengeni_private.open_inbox_item_v1(
            NEW.account_id, NEW.workspace_id, NEW.session_id, v_recipient, 'approval',
            v_approval ->> 'id',
            v_approval_title, v_approval_source,
            'normal');
          -- A new question reopens an item the person set aside for an
          -- earlier one.
          UPDATE opengeni_private.inbox_items item
          SET server_question = v_server_question,
            status = CASE WHEN item.status = 'dismissed' AND v_server_question IS NOT NULL
              AND (item.server_question ->> 'round') IS DISTINCT FROM
                (v_server_question ->> 'round')
              THEN 'open' ELSE item.status END
          WHERE item.session_id = NEW.session_id AND item.kind = 'approval'
            AND item.source_key = v_approval ->> 'id'
            AND item.recipient_subject_id = v_recipient
            AND item.server_question IS DISTINCT FROM v_server_question;
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
      -- A finished turn can no longer take an answer or a decision,
      -- except Opengeni's own secret approval cards, which outlive it.
      UPDATE opengeni_private.inbox_items item
      SET status = 'resolved', resolved_at = now(), updated_at = now()
      WHERE item.session_id = NEW.session_id
        AND item.kind IN ('question', 'approval')
        AND item.status IN ('open', 'dismissed')
        AND NOT (item.kind = 'question' AND EXISTS (
          SELECT 1 FROM session_human_input_requests request
          WHERE request.session_id = NEW.session_id
            AND request.id::text = item.source_key
            AND request.origin = 'secret_use_approval'
            AND request.status = 'pending'));
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
$_$;

DO $pin$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.enqueue_native_push_for_session_event_v1() SET search_path = pg_catalog, %I, pg_temp',
    current_schema()
  );
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.project_inbox_for_session_event_v1() SET search_path = pg_catalog, %I, pg_temp',
    current_schema()
  );
END
$pin$;

-- As v3, with each approval item's server question.
CREATE FUNCTION opengeni_private.list_inbox_items_v4(p_account_id uuid, p_subject_id text)
RETURNS TABLE (
  id uuid, workspace_id uuid, session_id uuid, kind text,
  source_key text, title text, subtitle text, body text, facts jsonb, link jsonb,
  event_sequence integer, choices jsonb, server_question jsonb, urgency text, status text,
  unread boolean, snoozed_until timestamptz, created_at timestamptz, updated_at timestamptz,
  resolved_at timestamptz, sender_subject_id text, sender_label text
)
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $list$
  SELECT item.id, item.workspace_id, item.session_id, item.kind,
    item.source_key, item.title, item.subtitle, item.body, item.facts, item.link,
    item.event_sequence, item.choices, item.server_question, item.urgency, item.status,
    item.seen_version < item.content_version, item.snoozed_until, item.created_at,
    item.updated_at, item.resolved_at, item.sender_subject_id, item.sender_label
  FROM opengeni_private.inbox_items item
  WHERE item.account_id = p_account_id
    AND item.recipient_subject_id = p_subject_id
    AND item.status = 'open'
  ORDER BY item.updated_at DESC
  LIMIT 500
$list$;

DO $inbox_server_questions$
DECLARE
  target_schema text := current_schema();
BEGIN
  REVOKE ALL ON FUNCTION opengeni_private.list_inbox_items_v4(uuid,text) FROM PUBLIC;
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.list_inbox_items_v4(uuid,text) SET search_path = pg_catalog, %I, pg_temp',
    target_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.list_inbox_items_v4(uuid,text) TO opengeni_app;
  END IF;
END $inbox_server_questions$;
