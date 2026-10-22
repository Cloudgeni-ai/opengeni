-- deployment-mode: rolling
-- A person can have the phone alerts for their agents' questions and approvals
-- arrive time-sensitive, so they break through Focus: their work is stopped
-- until they answer. Off by default; each person decides in each organization
-- (the API applies it in all of them).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE opengeni_private.inbox_settings
  ADD COLUMN time_sensitive_needs_you boolean NOT NULL DEFAULT false;

CREATE FUNCTION opengeni_private.inbox_settings_v4(p_account_id uuid, p_subject_id text)
RETURNS TABLE (
  tidy_policy text, paused_goals boolean, replies boolean, time_sensitive_needs_you boolean
)
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $settings$
  SELECT coalesce(settings.tidy_policy, 'own_sessions'), coalesce(settings.paused_goals, false),
    coalesce(settings.replies, false), coalesce(settings.time_sensitive_needs_you, false)
  FROM (SELECT 1) AS one
  LEFT JOIN opengeni_private.inbox_settings settings
    ON settings.account_id = p_account_id AND settings.subject_id = p_subject_id
$settings$;

-- Null leaves a setting as it is. Turning replies off takes their items away.
CREATE FUNCTION opengeni_private.set_inbox_settings_v4(
  p_account_id uuid, p_subject_id text, p_tidy_policy text, p_paused_goals boolean,
  p_replies boolean, p_time_sensitive_needs_you boolean
) RETURNS TABLE (
  tidy_policy text, paused_goals boolean, replies boolean, time_sensitive_needs_you boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $set$
BEGIN
  IF p_replies IS FALSE THEN
    UPDATE opengeni_private.inbox_items item
    SET status = 'withdrawn', resolved_at = now(), updated_at = now()
    WHERE item.account_id = p_account_id AND item.recipient_subject_id = p_subject_id
      AND item.kind = 'reply' AND item.status IN ('open', 'dismissed');
  END IF;
  RETURN QUERY
  INSERT INTO opengeni_private.inbox_settings AS settings
    (account_id, subject_id, tidy_policy, paused_goals, replies, time_sensitive_needs_you)
  VALUES (p_account_id, p_subject_id, coalesce(p_tidy_policy, 'own_sessions'),
    coalesce(p_paused_goals, false), coalesce(p_replies, false),
    coalesce(p_time_sensitive_needs_you, false))
  ON CONFLICT (account_id, subject_id) DO UPDATE SET
    tidy_policy = coalesce(p_tidy_policy, settings.tidy_policy),
    paused_goals = coalesce(p_paused_goals, settings.paused_goals),
    replies = coalesce(p_replies, settings.replies),
    time_sensitive_needs_you = coalesce(p_time_sensitive_needs_you,
      settings.time_sensitive_needs_you),
    updated_at = now()
  RETURNING settings.tidy_policy, settings.paused_goals, settings.replies,
    settings.time_sensitive_needs_you;
END
$set$;

-- As 0664, and a question or approval for a person who asked for it carries
-- urgency time_sensitive, which the sender turns into the alert's level.
CREATE OR REPLACE FUNCTION opengeni_private.enqueue_native_push_v2(
  p_session_id uuid, p_rule text, p_dedupe_key text, p_title text, p_body text,
  p_event_type text, p_extra jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $enqueue$
DECLARE
  v_session record;
  v_recipient text;
  v_urgency jsonb := '{}'::jsonb;
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
  IF p_rule = 'needs_input' AND EXISTS (
    SELECT 1 FROM opengeni_private.inbox_settings settings
    WHERE settings.account_id = v_session.account_id
      AND settings.subject_id = v_recipient
      AND settings.time_sensitive_needs_you
  ) THEN
    v_urgency := jsonb_build_object('urgency', 'time_sensitive');
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
    )) || coalesce(p_extra, '{}'::jsonb) || v_urgency
  FROM opengeni_private.native_push_devices device
  JOIN auth_sessions auth ON auth.id = device.auth_session_id AND auth.expires_at > now()
  WHERE device.subject_id = v_recipient AND p_rule = ANY (device.rules)
  ON CONFLICT (auth_session_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$enqueue$;

DO $inbox_time_sensitive_needs_you$
DECLARE
  target_schema text := current_schema();
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'inbox_settings_v4(uuid,text)',
    'set_inbox_settings_v4(uuid,text,text,boolean,boolean,boolean)',
    'enqueue_native_push_v2(uuid,text,text,text,text,text,jsonb)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.%s FROM PUBLIC', signature);
    EXECUTE format(
      'ALTER FUNCTION opengeni_private.%s SET search_path = pg_catalog, %I, pg_temp',
      signature, target_schema
    );
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.inbox_settings_v4(uuid,text),
      opengeni_private.set_inbox_settings_v4(uuid,text,text,boolean,boolean,boolean)
      TO opengeni_app;
  END IF;
END $inbox_time_sensitive_needs_you$;
