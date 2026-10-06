-- deployment-mode: rolling
-- Native app push. A signed-in phone app registers its push token against its
-- own app session (the revocable credential from /v1/native-app/token), so
-- signing the app out or revoking that session removes the registration.
-- Session events that need the person (a question or an approval), a finished
-- reply and a failed turn enqueue one delivery per registered device of the
-- person who started the session, in the event writer's transaction; a
-- dispatcher sends them through APNs or FCM. Storage stays private and is
-- reached only through the owner-run functions below.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE opengeni_private.native_push_devices (
  auth_session_id text PRIMARY KEY REFERENCES auth_sessions(id) ON DELETE CASCADE,
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 300),
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  app_id text NOT NULL CHECK (app_id ~ '^[A-Za-z0-9._-]{1,255}$'),
  environment text NOT NULL CHECK (environment IN ('development', 'production')),
  token text NOT NULL CHECK (char_length(token) BETWEEN 8 AND 4096),
  rules text[] NOT NULL
    CHECK (rules <@ ARRAY['needs_input', 'reply_ready', 'failed', 'agent']::text[]),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX native_push_devices_subject_idx
  ON opengeni_private.native_push_devices (subject_id);

CREATE TABLE opengeni_private.native_push_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_session_id text NOT NULL
    REFERENCES opengeni_private.native_push_devices(auth_session_id) ON DELETE CASCADE,
  dedupe_key text NOT NULL,
  rule text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  claim_id uuid,
  claimed_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  failed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (auth_session_id, dedupe_key)
);
CREATE INDEX native_push_deliveries_pending_idx
  ON opengeni_private.native_push_deliveries (next_attempt_at)
  WHERE delivered_at IS NULL AND failed_at IS NULL;

ALTER TABLE opengeni_private.native_push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.native_push_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY native_push_devices_owner ON opengeni_private.native_push_devices
  USING (current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner) FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'opengeni_private.native_push_devices'::regclass))
  WITH CHECK (current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner) FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'opengeni_private.native_push_devices'::regclass));
ALTER TABLE opengeni_private.native_push_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.native_push_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY native_push_deliveries_owner ON opengeni_private.native_push_deliveries
  USING (current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner) FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'opengeni_private.native_push_deliveries'::regclass))
  WITH CHECK (current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner) FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'opengeni_private.native_push_deliveries'::regclass));
REVOKE ALL ON TABLE opengeni_private.native_push_devices FROM PUBLIC;
REVOKE ALL ON TABLE opengeni_private.native_push_deliveries FROM PUBLIC;

-- The device registration of one live app session. The subject is derived
-- from the session itself, never supplied by the caller.
CREATE FUNCTION opengeni_private.native_push_device_v1(p_auth_session_id text)
RETURNS TABLE (
  platform text, app_id text, environment text, token text, rules text[], updated_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $device$
  SELECT device.platform, device.app_id, device.environment, device.token, device.rules,
    device.updated_at
  FROM opengeni_private.native_push_devices device
  JOIN auth_sessions session ON session.id = device.auth_session_id
  WHERE device.auth_session_id = p_auth_session_id AND session.expires_at > now()
$device$;

CREATE FUNCTION opengeni_private.register_native_push_device_v1(
  p_auth_session_id text, p_platform text, p_app_id text, p_environment text, p_token text,
  p_rules text[]
) RETURNS TABLE (
  platform text, app_id text, environment text, token text, rules text[], updated_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $register$
DECLARE
  v_subject text;
BEGIN
  SELECT 'user:' || session.user_id INTO v_subject
  FROM auth_sessions session
  WHERE session.id = p_auth_session_id AND session.expires_at > now();
  IF v_subject IS NULL THEN
    RAISE EXCEPTION 'native app session unavailable' USING ERRCODE = '42501';
  END IF;
  -- One token belongs to one install: a token re-registered by a newer app
  -- session of the same person replaces the older registration.
  DELETE FROM opengeni_private.native_push_devices device
  WHERE device.token = p_token AND device.subject_id = v_subject
    AND device.auth_session_id <> p_auth_session_id;
  RETURN QUERY
  INSERT INTO opengeni_private.native_push_devices AS device
    (auth_session_id, subject_id, platform, app_id, environment, token, rules)
  VALUES (p_auth_session_id, v_subject, p_platform, p_app_id, p_environment, p_token,
    ARRAY(SELECT DISTINCT unnest(p_rules) ORDER BY 1))
  ON CONFLICT (auth_session_id) DO UPDATE SET
    platform = excluded.platform, app_id = excluded.app_id,
    environment = excluded.environment, token = excluded.token, rules = excluded.rules,
    updated_at = now()
  RETURNING device.platform, device.app_id, device.environment, device.token, device.rules,
    device.updated_at;
END
$register$;

CREATE FUNCTION opengeni_private.unregister_native_push_device_v1(p_auth_session_id text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $unregister$
  DELETE FROM opengeni_private.native_push_devices WHERE auth_session_id = p_auth_session_id
$unregister$;

-- Fan one notification out to the live devices of the person who started the
-- session. Runs inside the caller's workspace RLS context, so the session is
-- only visible to the writer of its own workspace.
CREATE FUNCTION opengeni_private.enqueue_native_push_v1(
  p_session_id uuid, p_rule text, p_dedupe_key text, p_title text, p_body text,
  p_event_type text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $enqueue$
DECLARE
  v_session record;
  v_count integer;
BEGIN
  SELECT session.account_id, session.workspace_id, session.created_by_subject_id, session.title
    INTO v_session
  FROM sessions session
  WHERE session.id = p_session_id
    AND session.account_id = opengeni_private.current_account_id()
    AND session.workspace_id = opengeni_private.current_workspace_id();
  IF NOT FOUND OR v_session.created_by_subject_id NOT LIKE 'user:%' THEN
    RETURN 0;
  END IF;
  INSERT INTO opengeni_private.native_push_deliveries (auth_session_id, dedupe_key, rule, payload)
  SELECT device.auth_session_id, p_dedupe_key, p_rule, jsonb_strip_nulls(jsonb_build_object(
    'rule', p_rule,
    'eventType', p_event_type,
    'sessionId', p_session_id,
    'workspaceId', v_session.workspace_id,
    'subjectId', device.subject_id,
    'title', left(coalesce(nullif(btrim(p_title), ''), nullif(btrim(v_session.title), '')), 120),
    'body', left(nullif(btrim(p_body), ''), 240)
  ))
  FROM opengeni_private.native_push_devices device
  JOIN auth_sessions auth ON auth.id = device.auth_session_id AND auth.expires_at > now()
  WHERE device.subject_id = v_session.created_by_subject_id AND p_rule = ANY (device.rules)
  ON CONFLICT (auth_session_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$enqueue$;

CREATE FUNCTION opengeni_private.enqueue_native_push_for_session_event_v1()
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
      PERFORM opengeni_private.enqueue_native_push_v1(
        NEW.session_id, v_rule, NEW.id::text, NULL, v_body, NEW.type);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- A notification must never abort the lifecycle transaction that caused it.
    RAISE WARNING 'native push enqueue skipped for event %: %', NEW.id, SQLSTATE;
  END;
  RETURN NULL;
END
$event$;

CREATE TRIGGER session_events_native_push_enqueue_v1
AFTER INSERT ON session_events FOR EACH ROW
WHEN (NEW.duplicate_of_event_id IS NULL AND NEW.type IN (
  'session.humanInput.requested', 'session.requiresAction', 'turn.completed', 'turn.failed'
))
EXECUTE FUNCTION opengeni_private.enqueue_native_push_for_session_event_v1();

-- The dispatcher is one cross-tenant loop that reaches the outbox only here.
CREATE FUNCTION opengeni_private.claim_native_push_deliveries_v1(
  p_claim_id uuid, p_limit integer, p_claim_seconds integer
) RETURNS TABLE (
  delivery_id uuid, platform text, app_id text, environment text, token text, payload jsonb,
  attempts integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $claim$
BEGIN
  IF p_claim_id IS NULL THEN
    RAISE EXCEPTION 'native push claim id is required' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH picked AS (
    SELECT delivery.id FROM opengeni_private.native_push_deliveries delivery
    WHERE delivery.delivered_at IS NULL AND delivery.failed_at IS NULL
      AND delivery.next_attempt_at <= now()
      AND (delivery.claimed_until IS NULL OR delivery.claimed_until < now())
    ORDER BY delivery.next_attempt_at, delivery.created_at
    LIMIT greatest(1, least(p_limit, 100))
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE opengeni_private.native_push_deliveries delivery SET
      claim_id = p_claim_id,
      claimed_until = now() + make_interval(secs => greatest(5, least(p_claim_seconds, 600))),
      attempts = delivery.attempts + 1
    FROM picked WHERE delivery.id = picked.id
    RETURNING delivery.id, delivery.auth_session_id, delivery.payload, delivery.attempts
  )
  SELECT claimed.id, device.platform, device.app_id, device.environment, device.token,
    claimed.payload, claimed.attempts
  FROM claimed
  JOIN opengeni_private.native_push_devices device
    ON device.auth_session_id = claimed.auth_session_id;
END
$claim$;

-- delivered | retry | failed | unregistered (the provider no longer knows the
-- token, so the registration is removed with its pending deliveries).
CREATE FUNCTION opengeni_private.settle_native_push_delivery_v1(
  p_claim_id uuid, p_delivery_id uuid, p_outcome text, p_error text, p_retry_seconds integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $settle$
DECLARE
  v_session text;
BEGIN
  IF p_outcome = 'unregistered' THEN
    SELECT delivery.auth_session_id INTO v_session
    FROM opengeni_private.native_push_deliveries delivery
    WHERE delivery.id = p_delivery_id AND delivery.claim_id = p_claim_id;
    DELETE FROM opengeni_private.native_push_devices WHERE auth_session_id = v_session;
    RETURN;
  END IF;
  UPDATE opengeni_private.native_push_deliveries delivery SET
    delivered_at = CASE WHEN p_outcome = 'delivered' THEN now() END,
    failed_at = CASE WHEN p_outcome = 'failed' THEN now() END,
    next_attempt_at = CASE WHEN p_outcome = 'retry'
      THEN now() + make_interval(secs => greatest(1, least(p_retry_seconds, 3600)))
      ELSE delivery.next_attempt_at END,
    last_error = left(p_error, 500),
    claim_id = NULL,
    claimed_until = NULL
  WHERE delivery.id = p_delivery_id AND delivery.claim_id = p_claim_id;
END
$settle$;

CREATE FUNCTION opengeni_private.prune_native_push_deliveries_v1(
  p_retention_hours integer, p_limit integer
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $prune$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM opengeni_private.native_push_deliveries
  WHERE id IN (
    SELECT delivery.id FROM opengeni_private.native_push_deliveries delivery
    WHERE coalesce(delivery.delivered_at, delivery.failed_at)
      < now() - make_interval(hours => greatest(1, p_retention_hours))
    LIMIT greatest(1, least(p_limit, 10000))
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$prune$;

DO $native_push_search_paths$
DECLARE
  target_schema text := current_schema();
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'native_push_device_v1(text)',
    'register_native_push_device_v1(text,text,text,text,text,text[])',
    'unregister_native_push_device_v1(text)',
    'enqueue_native_push_v1(uuid,text,text,text,text,text)',
    'enqueue_native_push_for_session_event_v1()',
    'claim_native_push_deliveries_v1(uuid,integer,integer)',
    'settle_native_push_delivery_v1(uuid,uuid,text,text,integer)',
    'prune_native_push_deliveries_v1(integer,integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.%s FROM PUBLIC', signature);
    EXECUTE format(
      'ALTER FUNCTION opengeni_private.%s SET search_path = pg_catalog, %I, pg_temp',
      signature, target_schema
    );
  END LOOP;
END $native_push_search_paths$;

DO $native_push_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.native_push_device_v1(text),
      opengeni_private.register_native_push_device_v1(text,text,text,text,text,text[]),
      opengeni_private.unregister_native_push_device_v1(text),
      opengeni_private.enqueue_native_push_v1(uuid,text,text,text,text,text),
      opengeni_private.enqueue_native_push_for_session_event_v1(),
      opengeni_private.claim_native_push_deliveries_v1(uuid,integer,integer),
      opengeni_private.settle_native_push_delivery_v1(uuid,uuid,text,text,integer),
      opengeni_private.prune_native_push_deliveries_v1(integer,integer)
      TO opengeni_app;
  END IF;
END $native_push_grants$;

-- Rolling custom-role compatibility: whoever may write session events (and so
-- fire the trigger) gets the trigger's helpers too.
DO $native_push_rolling_grants$
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
      AND procedure.proname = 'enqueue_workspace_webhook_deliveries_v1'
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee <> procedure.proowner
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.enqueue_native_push_v1(uuid,text,text,text,text,text), opengeni_private.enqueue_native_push_for_session_event_v1() TO %I',
      target_role.rolname
    );
  END LOOP;
END $native_push_rolling_grants$;