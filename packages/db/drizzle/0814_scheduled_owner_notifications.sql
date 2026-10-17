-- deployment-mode: rolling
-- Scheduled owner notifications are runtime mechanics, not workspace-control
-- authority. Resolve their destination from accepted occurrence provenance,
-- never the current chat creator, mutable metadata or an agent argument.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION opengeni_private.scheduled_notification_context_v1(
  p_workspace uuid, p_session uuid, p_turn uuid, p_key text DEFAULT NULL
) RETURNS TABLE (run_id uuid, subject_id text, existing boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $context$
  WITH occurrence AS (
    SELECT run.id, run.account_id,
      CASE WHEN run.accepted_execution_snapshot ? 'causalHumanSubjectId'
        THEN run.accepted_execution_snapshot ->> 'causalHumanSubjectId'
        ELSE turn.initiating_human_subject_id END AS human
    FROM session_turns turn
    LEFT JOIN agent_learning_snapshots lineage
      ON lineage.account_id = turn.account_id AND lineage.workspace_id = turn.workspace_id
      AND lineage.session_id = turn.session_id AND lineage.turn_id = turn.id
    JOIN scheduled_task_runs run
      ON run.id = coalesce(turn.scheduled_task_run_id,
        (lineage.snapshot ->> 'scheduledTaskRunId')::uuid)
      AND run.account_id = turn.account_id AND run.workspace_id = turn.workspace_id
    WHERE turn.workspace_id = p_workspace AND turn.session_id = p_session AND turn.id = p_turn
      AND turn.account_id = opengeni_private.current_account_id()
      AND turn.workspace_id = opengeni_private.current_workspace_id()
  ), recipient AS (
    SELECT occurrence.id, occurrence.account_id,
      CASE WHEN occurrence.human LIKE 'user:%' THEN occurrence.human
        WHEN occurrence.human = 'dev' AND EXISTS (
          SELECT 1 FROM managed_accounts account WHERE account.id = occurrence.account_id
            AND account.external_source = 'opengeni:local' AND account.external_id = 'default'
        ) THEN occurrence.human END AS human
    FROM occurrence
  )
  SELECT recipient.id, recipient.human, EXISTS (
    SELECT 1 FROM opengeni_private.inbox_items item
    WHERE item.account_id = recipient.account_id AND item.workspace_id = p_workspace
      AND item.session_id = p_session AND item.recipient_subject_id = recipient.human
      AND item.kind = 'notification' AND item.source_key = p_key
      AND item.status IN ('open', 'dismissed')
  ) FROM recipient
$context$;

-- The following projection retains 0708's behavior except that a notification
-- from scheduled work uses the occurrence recipient (including explicit none).
-- Non-notification events keep their existing session recipient rules.
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
  v_scheduled record;
BEGIN
  BEGIN
    SELECT opengeni_private.session_person_v1(session.workspace_id, session.id,
        session.owner_subject_id, session.created_by_subject_id),
      session.parent_session_id IS NOT NULL,
      session.visibility = 'workspace_shared'
      INTO v_recipient, v_sub_agent, v_shared
    FROM sessions session WHERE session.id = NEW.session_id;
    IF NEW.type IN ('session.notification.posted', 'session.notification.withdrawn') THEN
      SELECT * INTO v_scheduled FROM opengeni_private.scheduled_notification_context_v1(
        NEW.workspace_id, NEW.session_id, NEW.turn_id, NULL);
      IF FOUND THEN v_recipient := v_scheduled.subject_id; END IF;
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

REVOKE ALL ON FUNCTION opengeni_private.scheduled_notification_context_v1(uuid,uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.project_inbox_for_session_event_v1() FROM PUBLIC;
DO $scheduled_notification_grants$
DECLARE target_role record;
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.scheduled_notification_context_v1(uuid,uuid,uuid,text) SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION opengeni_private.project_inbox_for_session_event_v1() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  -- Preserve custom runtime roles during a rolling deployment, as well as the
  -- stock role. Only existing inbox readers gain this scoped read helper.
  FOR target_role IN
    SELECT DISTINCT roles.rolname
    FROM pg_catalog.pg_proc procedure
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(procedure.proacl,
      pg_catalog.acldefault('f', procedure.proowner))) acl
    JOIN pg_catalog.pg_roles roles ON roles.oid = acl.grantee
    WHERE namespace.nspname = 'opengeni_private' AND procedure.proname = 'list_inbox_items_v3'
      AND acl.privilege_type = 'EXECUTE' AND acl.grantee <> procedure.proowner
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.scheduled_notification_context_v1(uuid,uuid,uuid,text) TO %I', target_role.rolname);
  END LOOP;
END $scheduled_notification_grants$;
