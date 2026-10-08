-- deployment-mode: rolling
-- The inbox: what waits on a person, across their workspaces. Session events
-- open and close items in the event writer's transaction, so an item can never
-- outlive the thing it points at: a question leaves when it is answered or its
-- turn ends, an approval when it is decided, a paused goal when it resumes, and
-- an agent's notification when that agent withdraws it. The person's own
-- attention (seen, snoozed, dismissed) lives on the same row. Nothing expires
-- with time. Storage stays private and is reached only through the owner-run
-- functions below; the recipient is the person who started the session.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE opengeni_private.inbox_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  recipient_subject_id text NOT NULL CHECK (char_length(recipient_subject_id) BETWEEN 1 AND 300),
  kind text NOT NULL CHECK (kind IN ('question', 'approval', 'goal_paused', 'notification')),
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 200),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 500),
  -- One-tap answers: the options of a single short single-select question, so
  -- the inbox and a phone notification can offer them as buttons.
  choices jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(choices) = 'array' AND jsonb_array_length(choices) <= 4),
  urgency text NOT NULL DEFAULT 'normal' CHECK (urgency IN ('normal', 'time_sensitive')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved', 'withdrawn', 'dismissed')),
  -- Unread while the person has not seen the current content.
  content_version integer NOT NULL DEFAULT 1 CHECK (content_version > 0),
  seen_version integer NOT NULL DEFAULT 0 CHECK (seen_version >= 0),
  snoozed_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (session_id, kind, source_key)
);
CREATE INDEX inbox_items_recipient_open_idx
  ON opengeni_private.inbox_items (account_id, recipient_subject_id, updated_at DESC)
  WHERE status = 'open';

CREATE TABLE opengeni_private.inbox_settings (
  account_id uuid NOT NULL,
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 300),
  tidy_policy text NOT NULL DEFAULT 'own_sessions'
    CHECK (tidy_policy IN ('own_sessions', 'any_agent')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, subject_id)
);

ALTER TABLE opengeni_private.inbox_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.inbox_items FORCE ROW LEVEL SECURITY;
CREATE POLICY inbox_items_owner ON opengeni_private.inbox_items
  USING (current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner) FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'opengeni_private.inbox_items'::regclass))
  WITH CHECK (current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner) FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'opengeni_private.inbox_items'::regclass));
ALTER TABLE opengeni_private.inbox_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.inbox_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY inbox_settings_owner ON opengeni_private.inbox_settings
  USING (current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner) FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'opengeni_private.inbox_settings'::regclass))
  WITH CHECK (current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner) FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'opengeni_private.inbox_settings'::regclass));
REVOKE ALL ON TABLE opengeni_private.inbox_items FROM PUBLIC;
REVOKE ALL ON TABLE opengeni_private.inbox_settings FROM PUBLIC;

-- Open (or refresh) one item. A refreshed item keeps the person's dismissal
-- and snooze, except that new content of a withdrawn or resolved item opens it
-- again. Returns whether the item is newly open (so the caller can alert).
CREATE FUNCTION opengeni_private.open_inbox_item_v1(
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
    left(coalesce(btrim(p_body), ''), 500),
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

CREATE FUNCTION opengeni_private.close_inbox_items_v1(
  p_session_id uuid, p_kinds text[], p_source_key text, p_status text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $close$
DECLARE
  v_count integer;
BEGIN
  UPDATE opengeni_private.inbox_items item
  SET status = p_status, resolved_at = now(), updated_at = now()
  WHERE item.session_id = p_session_id
    AND item.kind = ANY (p_kinds)
    AND (p_source_key IS NULL OR item.source_key = p_source_key)
    AND item.status IN ('open', 'dismissed');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$close$;

CREATE FUNCTION opengeni_private.project_inbox_for_session_event_v1()
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
    SELECT session.created_by_subject_id INTO v_recipient
    FROM sessions session WHERE session.id = NEW.session_id;
    IF v_recipient IS NULL OR v_recipient NOT LIKE 'user:%' THEN
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

CREATE TRIGGER session_events_inbox_projection_v1
AFTER INSERT ON session_events FOR EACH ROW
WHEN (NEW.duplicate_of_event_id IS NULL AND NEW.type IN (
  'session.humanInput.requested', 'session.requiresAction', 'user.humanInputResponse',
  'user.approvalDecision', 'turn.completed', 'turn.failed', 'turn.cancelled',
  'turn.superseded', 'goal.paused', 'goal.resumed', 'goal.cleared', 'goal.completed',
  'goal.set', 'session.notification.posted', 'session.notification.withdrawn'
))
EXECUTE FUNCTION opengeni_private.project_inbox_for_session_event_v1();

-- The person's open (or snoozed) items in one account. The caller filters to
-- workspaces the person can still reach and reads session titles under their
-- workspace context.
CREATE FUNCTION opengeni_private.list_inbox_items_v1(p_account_id uuid, p_subject_id text)
RETURNS TABLE (
  id uuid, workspace_id uuid, session_id uuid, kind text,
  source_key text, title text, body text, choices jsonb, urgency text, status text, unread boolean,
  snoozed_until timestamptz, created_at timestamptz, updated_at timestamptz,
  resolved_at timestamptz
)
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $list$
  SELECT item.id, item.workspace_id, item.session_id, item.kind,
    item.source_key, item.title, item.body, item.choices, item.urgency, item.status,
    item.seen_version < item.content_version, item.snoozed_until, item.created_at,
    item.updated_at, item.resolved_at
  FROM opengeni_private.inbox_items item
  WHERE item.account_id = p_account_id
    AND item.recipient_subject_id = p_subject_id
    AND item.status = 'open'
  ORDER BY item.updated_at DESC
  LIMIT 500
$list$;

-- The person's attention on one of their own items.
CREATE FUNCTION opengeni_private.update_inbox_item_attention_v1(
  p_item_id uuid, p_account_id uuid, p_subject_id text, p_seen boolean,
  p_set_snooze boolean, p_snoozed_until timestamptz, p_dismiss boolean
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $attention$
DECLARE
  v_id uuid;
BEGIN
  UPDATE opengeni_private.inbox_items item SET
    seen_version = CASE WHEN p_seen THEN item.content_version ELSE item.seen_version END,
    snoozed_until = CASE WHEN p_set_snooze THEN p_snoozed_until ELSE item.snoozed_until END,
    status = CASE WHEN p_dismiss AND item.status = 'open' THEN 'dismissed' ELSE item.status END,
    updated_at = CASE WHEN p_dismiss OR p_set_snooze THEN now() ELSE item.updated_at END
  WHERE item.id = p_item_id
    AND item.account_id = p_account_id
    AND item.recipient_subject_id = p_subject_id
  RETURNING item.id INTO v_id;
  RETURN v_id;
END
$attention$;

-- Agents tidying the inbox: dismiss another session's notification. The caller
-- enforces the person's tidy policy; questions, approvals and paused goals can
-- only be settled at their source.
CREATE FUNCTION opengeni_private.dismiss_inbox_notification_v1(
  p_item_id uuid, p_account_id uuid, p_subject_id text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $dismiss$
DECLARE
  v_id uuid;
BEGIN
  UPDATE opengeni_private.inbox_items item
  SET status = 'dismissed', updated_at = now()
  WHERE item.id = p_item_id AND item.account_id = p_account_id
    AND item.recipient_subject_id = p_subject_id
    AND item.kind = 'notification' AND item.status = 'open'
  RETURNING item.id INTO v_id;
  RETURN v_id;
END
$dismiss$;

CREATE FUNCTION opengeni_private.inbox_item_v1(p_item_id uuid, p_account_id uuid, p_subject_id text)
RETURNS TABLE (id uuid, workspace_id uuid, session_id uuid, kind text, source_key text, status text)
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $item$
  SELECT item.id, item.workspace_id, item.session_id, item.kind, item.source_key, item.status
  FROM opengeni_private.inbox_items item
  WHERE item.id = p_item_id AND item.account_id = p_account_id
    AND item.recipient_subject_id = p_subject_id
$item$;

CREATE FUNCTION opengeni_private.inbox_settings_v1(p_account_id uuid, p_subject_id text)
RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $settings$
  SELECT coalesce(
    (SELECT settings.tidy_policy FROM opengeni_private.inbox_settings settings
     WHERE settings.account_id = p_account_id AND settings.subject_id = p_subject_id),
    'own_sessions')
$settings$;

CREATE FUNCTION opengeni_private.set_inbox_settings_v1(
  p_account_id uuid, p_subject_id text, p_tidy_policy text
) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $set$
  INSERT INTO opengeni_private.inbox_settings (account_id, subject_id, tidy_policy)
  VALUES (p_account_id, p_subject_id, p_tidy_policy)
  ON CONFLICT (account_id, subject_id) DO UPDATE
    SET tidy_policy = excluded.tidy_policy, updated_at = now()
  RETURNING tidy_policy
$set$;

DO $inbox_search_paths$
DECLARE
  target_schema text := current_schema();
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'open_inbox_item_v1(uuid,uuid,uuid,text,text,text,text,text,text,jsonb)',
    'close_inbox_items_v1(uuid,text[],text,text)',
    'project_inbox_for_session_event_v1()',
    'list_inbox_items_v1(uuid,text)',
    'update_inbox_item_attention_v1(uuid,uuid,text,boolean,boolean,timestamptz,boolean)',
    'dismiss_inbox_notification_v1(uuid,uuid,text)',
    'inbox_item_v1(uuid,uuid,text)',
    'inbox_settings_v1(uuid,text)',
    'set_inbox_settings_v1(uuid,text,text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.%s FROM PUBLIC', signature);
    EXECUTE format(
      'ALTER FUNCTION opengeni_private.%s SET search_path = pg_catalog, %I, pg_temp',
      signature, target_schema
    );
  END LOOP;
END $inbox_search_paths$;

DO $inbox_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.open_inbox_item_v1(uuid,uuid,uuid,text,text,text,text,text,text,jsonb),
      opengeni_private.close_inbox_items_v1(uuid,text[],text,text),
      opengeni_private.project_inbox_for_session_event_v1(),
      opengeni_private.list_inbox_items_v1(uuid,text),
      opengeni_private.update_inbox_item_attention_v1(uuid,uuid,text,boolean,boolean,timestamptz,boolean),
      opengeni_private.dismiss_inbox_notification_v1(uuid,uuid,text),
      opengeni_private.inbox_item_v1(uuid,uuid,text),
      opengeni_private.inbox_settings_v1(uuid,text),
      opengeni_private.set_inbox_settings_v1(uuid,text,text)
      TO opengeni_app;
  END IF;
END $inbox_grants$;

-- Rolling custom-role compatibility: whoever may write session events (and so
-- fire the trigger) gets the trigger's helpers too.
DO $inbox_rolling_grants$
DECLARE target_role record;
BEGIN
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
      'GRANT EXECUTE ON FUNCTION opengeni_private.open_inbox_item_v1(uuid,uuid,uuid,text,text,text,text,text,text,jsonb), opengeni_private.close_inbox_items_v1(uuid,text[],text,text), opengeni_private.project_inbox_for_session_event_v1() TO %I',
      target_role.rolname
    );
  END LOOP;
END $inbox_rolling_grants$;
