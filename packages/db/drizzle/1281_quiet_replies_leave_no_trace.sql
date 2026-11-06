-- deployment-mode: rolling
-- A turn whose final answer is exactly NO_REPLY has nothing for the person:
-- timelines already draw nothing for it (an automation run with nothing to
-- say stays out of the chat). This makes it leave no trace for them either.
--
-- * Unread: the event cursor trigger no longer counts an agent message whose
--   text is the no-reply token, or a turn.completed whose output is, as
--   attention, so a quiet run sets no unread mark. The events stay in the
--   session's history. The partial attention index keeps its 0774
--   predicate; readers add the same exclusion as a filter on top of it, so
--   no index is rebuilt.
-- * Inbox: a quiet turn opens no reply item.
-- * Phone: a finished turn's push now carries its answer, the same text the
--   chat shows, instead of "The agent replied."; a turn with no answer, or
--   with the no-reply token as its answer, sends none.
--
-- no_reply_text_v1 matches isNoReplyText in @opengeni/contracts/no-reply.
-- The three trigger functions keep their signatures, so triggers and grants
-- are kept; the new helper is an owner-only SECURITY INVOKER function with no
-- runtime EXECUTE, so the previous release's readiness check accepts it.
-- Every function body is the previous version plus the change described.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Whether text is the no-reply token, tolerating Markdown wrapping: the
-- same normalization as isNoReplyText (@opengeni/contracts/no-reply).
CREATE OR REPLACE FUNCTION opengeni_private.no_reply_text_v1(p_text text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $$
  SELECT coalesce(char_length(p_text) <= 256
    AND upper(regexp_replace(p_text,
      '^[[:space:]`*_"''“”]+|[[:space:]`*_"''“”.!]+$', '', 'g')) = 'NO_REPLY', false)
$$;

REVOKE ALL ON FUNCTION opengeni_private.no_reply_text_v1(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION advance_session_event_cursors_for_inserted_events() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  fenced_access_capability_id uuid;
  inserted_group record;
  current_sequence integer;
BEGIN
  PERFORM pg_catalog.set_config(
    'opengeni.session_variable_set_attachments_v1',
    '1',
    true
  );
  fenced_access_capability_id :=
    opengeni_private.open_session_tenancy_fenced_access(
      session_tenancy_fence_target_schema()
    );
  FOR inserted_group IN
    SELECT
      account_id,
      workspace_id,
      session_id,
      MIN(sequence)::integer AS first_sequence,
      MAX(sequence)::integer AS last_sequence,
      MAX(sequence) FILTER (WHERE "event".type in ('agent.message.completed', 'turn.completed', 'turn.failed', 'session.requiresAction', 'session.humanInput.requested', 'tool.auth_needed', 'credential.auth_needed', 'goal.completed', 'goal.paused', 'goal.progress', 'goal.rewrite.proposed', 'rig.setup.failed', 'sandbox.operation.failed', 'sandbox.box.lost', 'workspace.revision.degraded', 'machine.op.failed', 'machine.link.lost', 'session.event.envelope_omitted')
    and "event".duplicate_of_event_id is null
    and ("event".turn_association is null or "event".turn_association = 'current')
    and ("event".type <> 'agent.message.completed' or coalesce("event".payload ->> 'text', '') <> '')
    and ("event".type <> 'agent.message.completed' or coalesce("event".payload ->> 'phase', '') <> 'commentary')
    -- 1281: an answer that is the no-reply token is nothing for the person.
    and ("event".type <> 'agent.message.completed'
      or not opengeni_private.no_reply_text_v1("event".payload ->> 'text'))
    and ("event".type <> 'turn.completed'
      or not opengeni_private.no_reply_text_v1("event".payload ->> 'output')
      or coalesce("event".payload ->> 'reply', '') <> '')
    and ("event".type <> 'turn.completed' or ("event".payload ->> 'segmentLimit') = 'session_usage_limit' or (
      not ("event".payload ?| array['maintenance', 'segmentLimit'])
      and ((
        coalesce(nullif("event".payload -> 'output', 'null'::jsonb), "event".payload -> 'result') is not null
        and coalesce(nullif("event".payload -> 'output', 'null'::jsonb), "event".payload -> 'result') not in ('null'::jsonb, '""'::jsonb)
      ) or coalesce("event".payload ->> 'reply', '') <> '')
    )))::integer AS last_meaningful_sequence,
      COUNT(*)::integer AS sequence_count,
      COUNT(DISTINCT sequence)::integer AS distinct_sequence_count,
      BOOL_OR(type NOT IN (
        'agent.message.delta',
        'agent.reasoning.delta',
        'sandbox.command.output.delta',
        'terminal.pty.output.delta'
      )) AS advances_activity,
      BOOL_OR(type NOT IN (
        'agent.message.delta',
        'agent.reasoning.delta',
        'sandbox.command.output.delta',
        'terminal.pty.output.delta',
        'sandbox.box.created',
        'sandbox.box.terminated',
        'sandbox.box.snapshot',
        'sandbox.env.drift',
        'session.route.reconciled',
        'workspace.revision.captured',
        'machine.op.recovered',
        'machine.link.restored',
        'machine.runner.restarted'
      )) AS advances_updated_at
    FROM inserted_session_events event
    GROUP BY account_id, workspace_id, session_id
    ORDER BY workspace_id, session_id
  LOOP
    SELECT last_sequence
    INTO current_sequence
    FROM session_event_cursors
    WHERE account_id = inserted_group.account_id
      AND workspace_id = inserted_group.workspace_id
      AND session_id = inserted_group.session_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'session event cursor is missing for an inserted event';
    END IF;
    IF inserted_group.distinct_sequence_count <> inserted_group.sequence_count
      OR inserted_group.first_sequence <> current_sequence + 1
      OR inserted_group.last_sequence <> current_sequence + inserted_group.sequence_count
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'session event insert does not exactly continue the durable cursor',
        DETAIL = pg_catalog.format(
          'workspace_id=%s session_id=%s current=%s first=%s last=%s count=%s distinct=%s',
          inserted_group.workspace_id,
          inserted_group.session_id,
          current_sequence,
          inserted_group.first_sequence,
          inserted_group.last_sequence,
          inserted_group.sequence_count,
          inserted_group.distinct_sequence_count
        );
    END IF;

    UPDATE session_event_cursors
    SET last_sequence = inserted_group.last_sequence,
        last_meaningful_sequence = greatest(last_meaningful_sequence, coalesce(inserted_group.last_meaningful_sequence, 0)),
        revision = revision + 1,
        updated_at = pg_catalog.now()
    WHERE account_id = inserted_group.account_id
      AND workspace_id = inserted_group.workspace_id
      AND session_id = inserted_group.session_id
      AND last_sequence = current_sequence;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'session event cursor changed while applying an inserted event statement';
    END IF;

    -- The wide column remains a semantic compatibility projection only. Raw
    -- batches leave it untouched; semantic SQL functions and old binaries are
    -- synchronized here even when they started from a stale projection.
    IF inserted_group.advances_activity THEN
      IF inserted_group.advances_updated_at THEN
        UPDATE sessions session
        SET last_sequence = inserted_group.last_sequence,
            updated_at = greatest(session.updated_at, statement_timestamp())
        WHERE session.account_id = inserted_group.account_id
          AND session.workspace_id = inserted_group.workspace_id
          AND session.id = inserted_group.session_id;
      ELSE
        UPDATE sessions session
        SET last_sequence = inserted_group.last_sequence
        WHERE session.account_id = inserted_group.account_id
          AND session.workspace_id = inserted_group.workspace_id
          AND session.id = inserted_group.session_id;
      END IF;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'session projection is missing for an inserted semantic event';
      END IF;
    END IF;
  END LOOP;
  PERFORM opengeni_private.close_session_tenancy_fenced_access(
    fenced_access_capability_id
  );
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  IF fenced_access_capability_id IS NOT NULL THEN
    PERFORM opengeni_private.close_session_tenancy_fenced_access(
      fenced_access_capability_id
    );
  END IF;
  RAISE;
END
$$;

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
  v_answer text;
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
    -- 1281: a finished turn's push says what the chat shows, its answer. A
    -- turn with no answer, or whose answer is the no-reply token (nothing
    -- for the person), sends none.
    IF v_rule = 'reply_ready' THEN
      IF NEW.turn_id IS NOT NULL THEN
        SELECT regexp_replace(event.payload ->> 'text', '^\s+|\s+$', '', 'g') INTO v_answer
        FROM session_events event
        WHERE event.workspace_id = NEW.workspace_id
          AND event.session_id = NEW.session_id
          AND event.turn_id = NEW.turn_id
          AND event.type = 'agent.message.completed'
          AND event.sequence < NEW.sequence
          AND coalesce(event.payload ->> 'phase', '') <> 'commentary'
          AND nullif(btrim(event.payload ->> 'text'), '') IS NOT NULL
        ORDER BY event.sequence DESC
        LIMIT 1;
      END IF;
      IF nullif(v_answer, '') IS NULL OR opengeni_private.no_reply_text_v1(v_answer) THEN
        v_rule := NULL;
      END IF;
      v_body := v_answer;
    END IF;
    IF v_rule IS NOT NULL AND NEW.session_id IS NOT NULL THEN
      PERFORM opengeni_private.enqueue_native_push_v2(
        NEW.session_id, v_rule, NEW.id::text, NULL,
        left(v_body, CASE WHEN v_rule = 'reply_ready' THEN 1000 ELSE 240 END), NEW.type,
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
        WHERE event.workspace_id = NEW.workspace_id
          AND event.session_id = NEW.session_id
          AND event.type = 'agent.message.completed'
          AND event.turn_id = NEW.turn_id
          AND event.sequence < NEW.sequence
          -- 1281: the answer, as the chat and the phone push show it.
          AND coalesce(event.payload ->> 'phase', '') <> 'commentary'
          AND nullif(btrim(event.payload ->> 'text'), '') IS NOT NULL
        ORDER BY event.sequence DESC
        LIMIT 1;
        -- 1281: an answer that is the no-reply token is nothing for the
        -- person, so a quiet turn opens no item.
        IF v_reply IS NOT NULL AND NOT opengeni_private.no_reply_text_v1(v_reply) THEN
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
    'ALTER FUNCTION %I.advance_session_event_cursors_for_inserted_events() SET search_path = pg_catalog, %I, pg_temp',
    current_schema(), current_schema()
  );
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

