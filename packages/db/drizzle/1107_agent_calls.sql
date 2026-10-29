-- deployment-mode: rolling
-- Agents can call a person: ring their phones with the system's incoming-call
-- screen, and answering joins the chat's voice call (docs/design/agent-calls.md).
--
-- 1. agent_calls: one row per call, visible in its workspace like the session
--    it belongs to. A second policy lets the owner-run functions below see
--    whether a person already has a phone ringing, across workspaces.
-- 2. Phones opt in per device: the `call` rule (agents working for this
--    person) and the `call_members` rule (agents of other members of a shared
--    workspace), never set unless the person turns them on, and, on iOS, the
--    PushKit token VoIP pushes go to.
-- 3. ring_agent_call_v1 queues one ring per eligible phone in the native push
--    outbox; claim_native_push_deliveries_v2 hands the dispatcher the VoIP
--    token alongside the alert token.
-- 4. Workspace webhooks can subscribe to session.agentCall.ringing and
--    session.agentCall.settled, with the call's bounded fields, so a product
--    embedding Opengeni can ring its own app with its own push credentials.
--
-- Rolling: the previous release never writes a call or the new rules, and
-- ignores the new column. The wider webhook check is added NOT VALID; every
-- existing row satisfies the narrower list.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE agent_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  callee_subject_id text NOT NULL,
  -- Set when the agent called another member: the person it works for.
  caller_subject_id text,
  -- What the ring screen and the chat show as the caller.
  caller_label text,
  reason text NOT NULL,
  state text NOT NULL DEFAULT 'ringing',
  devices integer NOT NULL DEFAULT 0,
  ring_until timestamptz NOT NULL,
  -- The app session (phone) that answered.
  answered_by text,
  -- The voice call that opened with the reason, once one has.
  realtime_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CONSTRAINT agent_calls_state_chk
    CHECK (state IN ('ringing', 'answered', 'declined', 'missed', 'cancelled')),
  CONSTRAINT agent_calls_values_chk CHECK (
    char_length(reason) BETWEEN 1 AND 200
    AND char_length(callee_subject_id) BETWEEN 1 AND 300
    AND (caller_subject_id IS NULL OR char_length(caller_subject_id) BETWEEN 1 AND 300)
    AND (caller_label IS NULL OR char_length(caller_label) BETWEEN 1 AND 200)
    AND (answered_by IS NULL OR char_length(answered_by) BETWEEN 1 AND 300)
    AND devices >= 0
    AND (state = 'ringing') = (ended_at IS NULL)
  )
);
CREATE INDEX agent_calls_session_idx ON agent_calls (workspace_id, session_id, created_at DESC);
CREATE INDEX agent_calls_ringing_callee_idx ON agent_calls (callee_subject_id)
  WHERE state = 'ringing';
CREATE INDEX agent_calls_ringing_deadline_idx ON agent_calls (ring_until)
  WHERE state = 'ringing';

ALTER TABLE agent_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON agent_calls
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
-- The owner-run functions below (whether a person is already being rung, and
-- the ring fan-out).
CREATE POLICY agent_calls_owner ON agent_calls
  USING (current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner) FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'agent_calls'::regclass))
  WITH CHECK (current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner) FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'agent_calls'::regclass));

DO $agent_calls_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE ON agent_calls TO opengeni_app;
  END IF;
END
$agent_calls_grants$;

-- Phones opt in to calls one by one.
ALTER TABLE opengeni_private.native_push_devices
  ADD COLUMN voip_token text CHECK (voip_token IS NULL OR char_length(voip_token) BETWEEN 8 AND 4096);
ALTER TABLE opengeni_private.native_push_devices
  DROP CONSTRAINT native_push_devices_rules_check,
  ADD CONSTRAINT native_push_devices_rules_check
    CHECK (rules <@ ARRAY[
      'needs_input', 'reply_ready', 'failed', 'agent', 'call', 'call_members'
    ]::text[]);

CREATE FUNCTION opengeni_private.native_push_device_v2(p_auth_session_id text)
RETURNS TABLE (
  platform text, app_id text, environment text, token text, rules text[], voip_token text,
  updated_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $device$
  SELECT device.platform, device.app_id, device.environment, device.token, device.rules,
    device.voip_token, device.updated_at
  FROM opengeni_private.native_push_devices device
  JOIN auth_sessions session ON session.id = device.auth_session_id
  WHERE device.auth_session_id = p_auth_session_id AND session.expires_at > now()
$device$;

-- v1 with the PushKit token. An iOS phone rings only through PushKit, so an
-- iOS registration without a VoIP token drops the call rules.
CREATE FUNCTION opengeni_private.register_native_push_device_v2(
  p_auth_session_id text, p_platform text, p_app_id text, p_environment text, p_token text,
  p_rules text[], p_voip_token text
) RETURNS TABLE (
  platform text, app_id text, environment text, token text, rules text[], voip_token text,
  updated_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $register$
DECLARE
  v_subject text;
  v_rules text[];
BEGIN
  SELECT 'user:' || session.user_id INTO v_subject
  FROM auth_sessions session
  WHERE session.id = p_auth_session_id AND session.expires_at > now();
  IF v_subject IS NULL THEN
    RAISE EXCEPTION 'native app session unavailable' USING ERRCODE = '42501';
  END IF;
  v_rules := ARRAY(
    SELECT DISTINCT rule FROM unnest(p_rules) rule
    WHERE rule NOT IN ('call', 'call_members') OR p_platform = 'android'
      OR nullif(p_voip_token, '') IS NOT NULL
    ORDER BY 1);
  -- Teammates' agents may call only a phone that also takes the person's own.
  IF 'call_members' = ANY (v_rules) AND NOT 'call' = ANY (v_rules) THEN
    v_rules := array_remove(v_rules, 'call_members');
  END IF;
  DELETE FROM opengeni_private.native_push_devices device
  WHERE device.token = p_token AND device.subject_id = v_subject
    AND device.auth_session_id <> p_auth_session_id;
  RETURN QUERY
  INSERT INTO opengeni_private.native_push_devices AS device
    (auth_session_id, subject_id, platform, app_id, environment, token, rules, voip_token)
  VALUES (p_auth_session_id, v_subject, p_platform, p_app_id, p_environment, p_token, v_rules,
    nullif(p_voip_token, ''))
  ON CONFLICT (auth_session_id) DO UPDATE SET
    platform = excluded.platform, app_id = excluded.app_id,
    environment = excluded.environment, token = excluded.token, rules = excluded.rules,
    voip_token = excluded.voip_token, updated_at = now()
  RETURNING device.platform, device.app_id, device.environment, device.token, device.rules,
    device.voip_token, device.updated_at;
END
$register$;

-- How many of this person's phones would ring: for their own agents, or, with
-- p_member, for an agent working for another member of a shared workspace.
CREATE FUNCTION opengeni_private.agent_call_device_count_v1(p_subject_id text, p_member boolean)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $count$
  SELECT count(*)::integer
  FROM opengeni_private.native_push_devices device
  JOIN auth_sessions auth ON auth.id = device.auth_session_id AND auth.expires_at > now()
  WHERE device.subject_id = p_subject_id
    AND (CASE WHEN p_member THEN 'call_members' ELSE 'call' END) = ANY (device.rules)
    AND (device.platform = 'android' OR device.voip_token IS NOT NULL)
$count$;

-- Whether a call is ringing this person right now, in any workspace: a person
-- is rung by one call at a time.
CREATE FUNCTION opengeni_private.agent_call_ringing_v1(p_subject_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $ringing$
  SELECT EXISTS (
    SELECT 1 FROM agent_calls call
    WHERE call.callee_subject_id = p_subject_id AND call.state = 'ringing'
      AND call.ring_until > now()
  )
$ringing$;

-- Queue one ring per eligible phone of the callee. Runs in the caller's
-- workspace RLS context; the call must be visible there and still ringing.
CREATE FUNCTION opengeni_private.ring_agent_call_v1(p_call_id uuid, p_member boolean)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $ring$
DECLARE
  v_call record;
  v_count integer;
BEGIN
  SELECT call.id, call.workspace_id, call.session_id, call.callee_subject_id, call.reason,
      call.caller_label, call.ring_until
    INTO v_call
  FROM agent_calls call
  WHERE call.id = p_call_id AND call.state = 'ringing'
    AND call.account_id = opengeni_private.current_account_id()
    AND call.workspace_id = opengeni_private.current_workspace_id();
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  INSERT INTO opengeni_private.native_push_deliveries
    (auth_session_id, dedupe_key, rule, payload)
  SELECT device.auth_session_id, 'call:' || v_call.id::text, 'call', jsonb_strip_nulls(
    jsonb_build_object(
      'rule', 'call',
      'callId', v_call.id,
      'sessionId', v_call.session_id,
      'workspaceId', v_call.workspace_id,
      'subjectId', device.subject_id,
      'title', left(nullif(btrim(v_call.caller_label), ''), 120),
      'body', left(v_call.reason, 200),
      'ringUntil', to_char(v_call.ring_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ))
  FROM opengeni_private.native_push_devices device
  JOIN auth_sessions auth ON auth.id = device.auth_session_id AND auth.expires_at > now()
  WHERE device.subject_id = v_call.callee_subject_id
    AND (CASE WHEN p_member THEN 'call_members' ELSE 'call' END) = ANY (device.rules)
    AND (device.platform = 'android' OR device.voip_token IS NOT NULL)
  ON CONFLICT (auth_session_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$ring$;

-- v1 plus the VoIP token, which call rings go to on iOS.
CREATE FUNCTION opengeni_private.claim_native_push_deliveries_v2(
  p_claim_id uuid, p_limit integer, p_claim_seconds integer
) RETURNS TABLE (
  delivery_id uuid, platform text, app_id text, environment text, token text, voip_token text,
  payload jsonb, attempts integer
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
    device.voip_token, claimed.payload, claimed.attempts
  FROM claimed
  JOIN opengeni_private.native_push_devices device
    ON device.auth_session_id = claimed.auth_session_id;
END
$claim$;

DO $agent_call_search_paths$
DECLARE
  target_schema text := current_schema();
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'native_push_device_v2(text)',
    'register_native_push_device_v2(text,text,text,text,text,text[],text)',
    'agent_call_device_count_v1(text,boolean)',
    'agent_call_ringing_v1(text)',
    'ring_agent_call_v1(uuid,boolean)',
    'claim_native_push_deliveries_v2(uuid,integer,integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.%s FROM PUBLIC', signature);
    EXECUTE format(
      'ALTER FUNCTION opengeni_private.%s SET search_path = pg_catalog, %I, pg_temp',
      signature, target_schema
    );
  END LOOP;
END $agent_call_search_paths$;

DO $agent_call_function_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.native_push_device_v2(text),
      opengeni_private.register_native_push_device_v2(text,text,text,text,text,text[],text),
      opengeni_private.agent_call_device_count_v1(text,boolean),
      opengeni_private.agent_call_ringing_v1(text),
      opengeni_private.ring_agent_call_v1(uuid,boolean),
      opengeni_private.claim_native_push_deliveries_v2(uuid,integer,integer)
      TO opengeni_app;
  END IF;
END $agent_call_function_grants$;

ALTER TABLE workspace_webhooks DROP CONSTRAINT workspace_webhooks_event_types_chk;
ALTER TABLE workspace_webhooks ADD CONSTRAINT workspace_webhooks_event_types_chk CHECK (
  cardinality(event_types) BETWEEN 1 AND 32 AND event_types <@ ARRAY[
    'turn.completed','turn.failed','turn.cancelled','session.status.changed',
    'session.requiresAction','session.humanInput.requested',
    'session.notification.posted','session.notification.withdrawn',
    'session.agentCall.ringing','session.agentCall.settled',
    'usage.threshold_reached','usage.exhausted','usage.period_reset',
    'recording.started','recording.finished','recording.transcript.ready',
    'recording.transcript.failed','recording.transcript.current_changed',
    'recording.speakers.updated','recording.notes.updated','recording.deleted'
  ]::text[]
) NOT VALID;

DROP TRIGGER session_events_workspace_webhook_enqueue_v1 ON session_events;
CREATE TRIGGER session_events_workspace_webhook_enqueue_v1
AFTER INSERT ON session_events FOR EACH ROW
WHEN (NEW.duplicate_of_event_id IS NULL AND NEW.type IN (
  'turn.completed', 'turn.failed', 'turn.cancelled', 'session.status.changed',
  'session.requiresAction', 'session.humanInput.requested',
  'session.notification.posted', 'session.notification.withdrawn',
  'session.agentCall.ringing', 'session.agentCall.settled'
))
EXECUTE FUNCTION opengeni_private.enqueue_workspace_webhook_deliveries_v1();

-- 0736's payload plus the call fields. Organization webhooks never carry call
-- events (their trigger and check are unchanged).
CREATE OR REPLACE FUNCTION opengeni_private.integration_webhook_payload_v1(
  p_account uuid, p_workspace uuid, p_event uuid, p_type text, p_session uuid,
  p_turn uuid, p_sequence bigint, p_occurred timestamptz, p_payload jsonb,
  p_lane text DEFAULT 'workspace'
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT
AS $payload$
DECLARE workspace_value jsonb; subject_value text; human_value jsonb; data_value jsonb;
BEGIN
  IF p_lane NOT IN ('workspace', 'organization') OR p_lane IS NULL
    OR p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN RAISE EXCEPTION 'integration payload scope invalid' USING ERRCODE = '42501'; END IF;
  SELECT jsonb_build_object('id', id, 'externalSource', external_source, 'externalId', external_id)
    INTO workspace_value FROM workspaces WHERE id = p_workspace AND account_id = p_account;
  IF p_type IN ('turn.completed', 'turn.failed', 'turn.cancelled') AND p_turn IS NOT NULL THEN
    SELECT initiating_human_subject_id INTO subject_value FROM session_turns
      WHERE id = p_turn AND session_id = p_session AND workspace_id = p_workspace AND account_id = p_account;
    human_value := opengeni_private.resolve_integration_initiating_human_v1(p_account, p_workspace, subject_value, p_turn);
  END IF;
  IF p_type IN ('session.notification.posted', 'session.notification.withdrawn') THEN
    data_value := jsonb_strip_nulls(jsonb_build_object(
      'key', CASE WHEN jsonb_typeof(p_payload->'key') = 'string' THEN left(p_payload->>'key', 120) END,
      'recipientSubjectId', CASE WHEN jsonb_typeof(p_payload->'recipientSubjectId') = 'string'
        THEN left(p_payload->>'recipientSubjectId', 300) END
    ));
    IF p_type = 'session.notification.posted' THEN
      data_value := data_value || jsonb_strip_nulls(jsonb_build_object(
        'title', CASE WHEN jsonb_typeof(p_payload->'title') = 'string' THEN left(p_payload->>'title', 80) END,
        'subtitle', CASE WHEN jsonb_typeof(p_payload->'subtitle') = 'string' THEN left(p_payload->>'subtitle', 80) END,
        'body', CASE WHEN jsonb_typeof(p_payload->'body') = 'string' THEN left(p_payload->>'body', 1000) END,
        'urgency', CASE WHEN p_payload->>'urgency' IN ('normal', 'time_sensitive') THEN p_payload->>'urgency' END,
        'replaced', CASE WHEN jsonb_typeof(p_payload->'replaced') = 'boolean' THEN p_payload->'replaced' END,
        'facts', CASE WHEN jsonb_typeof(p_payload->'facts') = 'array' THEN (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'label', left(fact->>'label', 24), 'value', left(fact->>'value', 80)
          ) ORDER BY position), '[]'::jsonb)
          FROM jsonb_array_elements(p_payload->'facts') WITH ORDINALITY AS facts(fact, position)
          WHERE position <= 4 AND jsonb_typeof(fact->'label') = 'string'
            AND jsonb_typeof(fact->'value') = 'string'
        ) END,
        'link', CASE WHEN jsonb_typeof(p_payload->'link'->'url') = 'string'
          AND jsonb_typeof(p_payload->'link'->'label') = 'string' THEN jsonb_build_object(
            'url', left(p_payload->'link'->>'url', 2000), 'label', left(p_payload->'link'->>'label', 40)
          ) END,
        'sender', CASE WHEN jsonb_typeof(p_payload->'sender'->'subjectId') = 'string'
          AND jsonb_typeof(p_payload->'sender'->'label') = 'string' THEN jsonb_build_object(
            'subjectId', left(p_payload->'sender'->>'subjectId', 300), 'label', left(p_payload->'sender'->>'label', 200)
          ) END,
        'undeliveredReason', CASE WHEN p_payload->>'undeliveredReason' IN ('no_human_recipient')
          THEN p_payload->>'undeliveredReason' END
      ));
    END IF;
  ELSIF p_type IN ('session.agentCall.ringing', 'session.agentCall.settled') THEN
    data_value := jsonb_strip_nulls(jsonb_build_object(
      'callId', CASE WHEN jsonb_typeof(p_payload->'callId') = 'string' THEN left(p_payload->>'callId', 64) END,
      'calleeSubjectId', CASE WHEN jsonb_typeof(p_payload->'calleeSubjectId') = 'string'
        THEN left(p_payload->>'calleeSubjectId', 300) END,
      'callerLabel', CASE WHEN jsonb_typeof(p_payload->'callerLabel') = 'string'
        THEN left(p_payload->>'callerLabel', 200) END,
      'reason', CASE WHEN jsonb_typeof(p_payload->'reason') = 'string' THEN left(p_payload->>'reason', 200) END,
      'ringUntil', CASE WHEN jsonb_typeof(p_payload->'ringUntil') = 'string' THEN left(p_payload->>'ringUntil', 40) END,
      'outcome', CASE WHEN p_payload->>'outcome' IN ('answered', 'declined', 'missed', 'cancelled')
        THEN p_payload->>'outcome' END
    ));
  ELSE
    data_value := jsonb_strip_nulls(jsonb_build_object(
      'status', CASE WHEN jsonb_typeof(p_payload -> 'status') = 'string' THEN left(p_payload ->> 'status', 64) END,
      'reason', CASE WHEN jsonb_typeof(p_payload -> 'reason') = 'string' THEN left(p_payload ->> 'reason', 200) END
    ));
  END IF;
  RETURN jsonb_build_object(
    'id', p_event, 'type', p_type, 'lane', p_lane, 'workspaceId', p_workspace, 'workspace', workspace_value,
    'sessionId', p_session, 'turnId', p_turn, 'initiatingHuman', human_value,
    'sequence', p_sequence,
    'occurredAt', to_char(p_occurred AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'data', data_value
  );
END $payload$;
REVOKE ALL ON FUNCTION opengeni_private.integration_webhook_payload_v1(uuid,uuid,uuid,text,uuid,uuid,bigint,timestamptz,jsonb,text) FROM PUBLIC;
DO $agent_call_webhook_path$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.integration_webhook_payload_v1(uuid,uuid,uuid,text,uuid,uuid,bigint,timestamptz,jsonb,text)
    SET search_path=pg_catalog,%I,pg_temp',current_schema());
END $agent_call_webhook_path$;

RESET statement_timeout;
RESET lock_timeout;
