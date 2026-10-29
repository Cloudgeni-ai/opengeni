-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: touches only approval items still waiting on a person, a handful of rows
-- An approval waiting in the inbox, on the phone and in desktop notifications
-- was titled with the raw tool name ("batch_modify_messages") and its push
-- read "Approve batch_modify_messages?". The chat's approval card already
-- says what the action does ("Update 3 messages") and where (Gmail).
--
-- Now an approval item is titled with the approval's display title (the
-- worker sets it to the review card's title), or else a readable form of the
-- tool name ("Modify messages"). Its body names where the action runs: the
-- integration, and the account when there are several ("Gmail"). A later
-- pause that names the same approval without display details keeps the
-- title and body the item opened with. The push says "Needs your approval:
-- Update 3 messages (Gmail)".
--
-- Both trigger functions are unchanged from the 0977 baseline apart from the
-- approval wording. Same signatures, so triggers and grants are kept. The
-- previous release writes the same event payloads, so both can run against
-- this schema.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- "mcp_gmail__batch_modify_messages" → "Modify messages"; a display title wins.
CREATE OR REPLACE FUNCTION opengeni_private.inbox_approval_title_v1(p_approval jsonb) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  v_name text;
BEGIN
  IF nullif(btrim(p_approval #>> '{display,title}'), '') IS NOT NULL THEN
    RETURN left(btrim(p_approval #>> '{display,title}'), 200);
  END IF;
  v_name := coalesce(nullif(btrim(p_approval #>> '{display,toolName}'), ''),
    nullif(btrim(p_approval ->> 'name'), ''), nullif(btrim(p_approval ->> 'toolName'), ''),
    nullif(btrim(p_approval #>> '{rawItem,name}'), ''),
    nullif(btrim(p_approval #>> '{raw,name}'), ''), '');
  IF v_name = '' OR v_name = 'tool' OR v_name ~ '^[a-f0-9]{64}$' THEN
    RETURN 'A tool call';
  END IF;
  -- The model-visible prefix names the server, not the action.
  v_name := regexp_replace(v_name, '^.*__', '');
  -- Batching is how a call is grouped, not what it does.
  v_name := regexp_replace(v_name, '^batch[_-]+(?=[A-Za-z])', '', 'i');
  v_name := regexp_replace(v_name, '([a-z0-9])([A-Z])', '\1 \2', 'g');
  v_name := lower(btrim(regexp_replace(v_name, '[_.\-\s]+', ' ', 'g')));
  IF v_name = '' THEN
    RETURN 'A tool call';
  END IF;
  RETURN left(upper(left(v_name, 1)) || substr(v_name, 2), 200);
END
$$;

-- Where the action runs: "Gmail", or "Gmail · work@example.com" when the
-- chat has several Gmail accounts.
CREATE OR REPLACE FUNCTION opengeni_private.inbox_approval_source_v1(p_approval jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $$
  SELECT left(coalesce(nullif(concat_ws(' · ',
      nullif(btrim(p_approval #>> '{display,connector}'), ''),
      nullif(btrim(p_approval #>> '{display,accountLabel}'), '')), ''),
    nullif(btrim(p_approval #>> '{display,serverName}'), ''), ''), 200)
$$;

REVOKE ALL ON FUNCTION opengeni_private.inbox_approval_title_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.inbox_approval_source_v1(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION opengeni_private.enqueue_native_push_for_session_event_v1() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  v_rule text;
  v_body text;
  v_title text;
  v_source text;
BEGIN
  BEGIN
    IF NEW.type = 'session.requiresAction' THEN
      v_title := opengeni_private.inbox_approval_title_v1(
        coalesce(NEW.payload #> '{approvals,0}', '{}'::jsonb));
      v_source := nullif(opengeni_private.inbox_approval_source_v1(
        coalesce(NEW.payload #> '{approvals,0}', '{}'::jsonb)), '');
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
      WHEN 'session.requiresAction' THEN CASE WHEN v_title LIKE '%?'
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
        jsonb_build_object('sequence', NEW.sequence));
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
          -- A later pause of the same turn names its remaining approvals
          -- without display details; keep what the open item already says.
          IF jsonb_typeof(v_approval -> 'display') IS DISTINCT FROM 'object' THEN
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

-- Approvals still waiting read the same way now. Only open items are
-- touched, each from the pause event that opened it.
UPDATE opengeni_private.inbox_items item
SET title = opengeni_private.inbox_approval_title_v1(approval.value),
  body = opengeni_private.inbox_approval_source_v1(approval.value),
  content_version = item.content_version + 1
FROM session_events event
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(event.payload -> 'approvals') = 'array'
    THEN event.payload -> 'approvals' ELSE '[]'::jsonb END) AS approval(value)
WHERE item.kind = 'approval'
  AND item.status IN ('open', 'dismissed')
  AND item.event_sequence IS NOT NULL
  AND event.workspace_id = item.workspace_id
  AND event.session_id = item.session_id
  AND event.sequence = item.event_sequence
  AND event.type = 'session.requiresAction'
  AND approval.value ->> 'id' = item.source_key
  AND jsonb_typeof(approval.value -> 'display') = 'object';
