-- deployment-mode: rolling
-- A connection card (connect, reconnect or more access) the agent waits on
-- needs the person, as an approval does. The card is announced with a
-- `session.notification.posted` event whose key starts with
-- `connection-card:` (CONNECTION_CARD_NOTICE_PREFIX in @opengeni/contracts)
-- and withdrawn with `session.notification.withdrawn` under the same key once
-- the card is done. This keeps that state on the session, so chat lists and
-- the sub-agent bar can show an idle chat that waits on a card as needing the
-- person without reading its history:
--
-- * sessions.awaiting_connection_keys: the keys of the chat's open
--   connection-card notices; null when none is open.
-- * sessions.awaiting_connection_since: when the oldest of them was posted
--   (kept while any stays open); null when none is open.
-- * An AFTER INSERT trigger on session_events maintains both: a posted
--   notice adds its key, a withdrawn one removes it, and a turn's first
--   `turn.started` clears them: once the agent works again (the person wrote, the card's
--   setup continued it, or anything else woke it) it no longer waits, and a
--   card it still needs is posted again by that turn. A failure
--   is a warning and never aborts the event's transaction. Imported
--   read-only chats are left alone.
-- * The inbox trigger also takes `turn.started`, which closes the chat's
--   open connection-card notices (status withdrawn). Its function is 1289's
--   plus that branch; same signature, so grants are kept.
-- * A new session never starts waiting: a BEFORE INSERT trigger clears the
--   columns a fork copies from its source row.
-- * Changing the timestamp notifies session lists, like other list fields.
--
-- Rolling: both columns are nullable without default (catalog-only), the new
-- routines are SECURITY INVOKER, and the previous release neither reads nor
-- writes the columns.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS awaiting_connection_since timestamptz,
  ADD COLUMN IF NOT EXISTS awaiting_connection_keys text[];
COMMENT ON COLUMN sessions.awaiting_connection_since IS
  'When the oldest still-open connection-card notice of this chat was posted; null when none is open. Maintained by session_events_connection_wait_v1.';
COMMENT ON COLUMN sessions.awaiting_connection_keys IS
  'Keys of this chat''s open connection-card notices (connection-card:...); null when none is open. Maintained by session_events_connection_wait_v1.';

CREATE OR REPLACE FUNCTION opengeni_private.track_session_connection_wait_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path FROM CURRENT
AS $track$
DECLARE
  v_key text;
BEGIN
  BEGIN
    IF NEW.type = 'turn.started' THEN
      -- Only a turn's first start: a resume after an approval or an answer
      -- continues the same turn, whose cards are not posted again.
      IF NEW.turn_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM session_events earlier
        WHERE earlier.workspace_id = NEW.workspace_id AND earlier.turn_id = NEW.turn_id
          AND earlier.type = 'turn.started' AND earlier.id <> NEW.id) THEN
        RETURN NULL;
      END IF;
      UPDATE sessions SET awaiting_connection_since = NULL, awaiting_connection_keys = NULL
      WHERE workspace_id = NEW.workspace_id AND id = NEW.session_id
        AND (awaiting_connection_keys IS NOT NULL OR awaiting_connection_since IS NOT NULL);
      RETURN NULL;
    END IF;
    IF jsonb_typeof(NEW.payload -> 'key') IS DISTINCT FROM 'string'
      OR nullif(NEW.payload ->> 'recipientSubjectId', '') IS NOT NULL THEN
      RETURN NULL;
    END IF;
    v_key := NEW.payload ->> 'key';
    IF NOT starts_with(v_key, 'connection-card:') THEN RETURN NULL; END IF;
    IF NEW.type = 'session.notification.posted' THEN
      -- A repeat card updates its notice in place: the wait keeps its start.
      UPDATE sessions SET
        awaiting_connection_keys = array_append(coalesce(awaiting_connection_keys, '{}'), v_key),
        awaiting_connection_since = coalesce(awaiting_connection_since, NEW.occurred_at)
      WHERE workspace_id = NEW.workspace_id AND id = NEW.session_id
        AND imported_archive_import_id IS NULL
        AND NOT (v_key = ANY (coalesce(awaiting_connection_keys, '{}')));
    ELSIF NEW.type = 'session.notification.withdrawn' THEN
      UPDATE sessions SET
        awaiting_connection_keys = nullif(array_remove(awaiting_connection_keys, v_key), '{}'),
        awaiting_connection_since = CASE
          WHEN cardinality(array_remove(awaiting_connection_keys, v_key)) = 0 THEN NULL
          ELSE awaiting_connection_since END
      WHERE workspace_id = NEW.workspace_id AND id = NEW.session_id
        AND v_key = ANY (awaiting_connection_keys);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- A chat list hint must never abort the lifecycle transaction.
    RAISE WARNING 'connection card wait skipped for event %: %', NEW.id, SQLSTATE;
  END;
  RETURN NULL;
END
$track$;

CREATE TRIGGER session_events_connection_wait_v1 AFTER INSERT ON session_events
  FOR EACH ROW
  WHEN (NEW.duplicate_of_event_id IS NULL AND (NEW.type = 'turn.started'
    OR (NEW.type IN ('session.notification.posted', 'session.notification.withdrawn')
      AND starts_with(NEW.payload ->> 'key', 'connection-card:'))))
  EXECUTE FUNCTION opengeni_private.track_session_connection_wait_v1();

CREATE OR REPLACE FUNCTION opengeni_private.reset_session_connection_wait_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT
AS $reset$
BEGIN
  NEW.awaiting_connection_since := NULL;
  NEW.awaiting_connection_keys := NULL;
  RETURN NEW;
END
$reset$;

CREATE TRIGGER sessions_connection_wait_insert_reset_v1 BEFORE INSERT ON sessions
  FOR EACH ROW
  WHEN (NEW.awaiting_connection_since IS NOT NULL OR NEW.awaiting_connection_keys IS NOT NULL)
  EXECUTE FUNCTION opengeni_private.reset_session_connection_wait_v1();

CREATE TRIGGER sessions_list_connection_wait_update_v1 AFTER UPDATE OF awaiting_connection_since
  ON sessions FOR EACH ROW
  WHEN (OLD.awaiting_connection_since IS DISTINCT FROM NEW.awaiting_connection_since)
  EXECUTE FUNCTION notify_session_list_change();

-- 1289's inbox projection plus the `turn.started` branch.
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
    IF NEW.type = 'turn.started' THEN
      -- Only a turn's first start: a resume after an approval or an answer
      -- continues the same turn, whose cards are not posted again.
      IF NEW.turn_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM session_events earlier
        WHERE earlier.workspace_id = NEW.workspace_id AND earlier.turn_id = NEW.turn_id
          AND earlier.type = 'turn.started' AND earlier.id <> NEW.id) THEN
        RETURN NULL;
      END IF;
      -- The agent works again: it no longer waits on the chat's connection
      -- cards, and one it still needs is posted again by this turn.
      UPDATE opengeni_private.inbox_items item
      SET status = 'withdrawn', resolved_at = now(), updated_at = now()
      WHERE item.session_id = NEW.session_id AND item.kind = 'notification'
        AND starts_with(item.source_key, 'connection-card:')
        AND item.status IN ('open', 'dismissed');
      RETURN NULL;
    END IF;
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
          -- 1289: the answer, as the chat and the phone push show it.
          AND coalesce(event.payload ->> 'phase', '') <> 'commentary'
          AND nullif(btrim(event.payload ->> 'text'), '') IS NOT NULL
        ORDER BY event.sequence DESC
        LIMIT 1;
        -- 1289: an answer that is the no-reply token is nothing for the
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

DROP TRIGGER session_events_inbox_projection_v1 ON session_events;
CREATE TRIGGER session_events_inbox_projection_v1 AFTER INSERT ON session_events
  FOR EACH ROW
  WHEN (NEW.duplicate_of_event_id IS NULL AND (NEW.type IN (
    'session.humanInput.requested', 'session.requiresAction', 'user.humanInputResponse',
    'user.approvalDecision', 'turn.completed', 'turn.failed', 'turn.cancelled',
    'turn.superseded', 'goal.paused', 'goal.resumed', 'goal.cleared', 'goal.completed',
    'goal.set', 'session.notification.posted', 'session.notification.withdrawn')
    OR NEW.type = 'turn.started'))
  EXECUTE FUNCTION opengeni_private.project_inbox_for_session_event_v1();

DO $pin$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.project_inbox_for_session_event_v1() SET search_path = pg_catalog, %I, pg_temp',
    current_schema()
  );
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.track_session_connection_wait_v1() SET search_path = pg_catalog, %I, pg_temp',
    current_schema()
  );
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.reset_session_connection_wait_v1() SET search_path = pg_catalog, %I, pg_temp',
    current_schema()
  );
END
$pin$;

-- Trigger functions fire without EXECUTE; nobody calls them directly.
REVOKE ALL ON FUNCTION opengeni_private.track_session_connection_wait_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.reset_session_connection_wait_v1() FROM PUBLIC;
