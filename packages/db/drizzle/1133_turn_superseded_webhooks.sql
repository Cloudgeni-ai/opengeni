-- deployment-mode: rolling
-- A turn that a new message (a Steer) takes over settles as `superseded`, but
-- webhooks never carried that settlement: a host listening for terminal turn
-- webhooks only learned about the interrupted turn from its own polling.
--
-- `turn.superseded` becomes a subscribable webhook type for workspace and
-- organization endpoints. Like the other turn types it forwards the session
-- event as it is, with `initiatingHuman` when known, so every settled turn now
-- has one terminal webhook: completed, failed, cancelled or superseded.
-- Existing registrations are unchanged; an endpoint receives it once it
-- subscribes.
--
-- The previous release never subscribes an endpoint to the new type, so it
-- neither creates nor reads deliveries of it. The checks are added NOT VALID
-- because every existing row already satisfies the narrower list.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE workspace_webhooks DROP CONSTRAINT workspace_webhooks_event_types_chk;
ALTER TABLE workspace_webhooks ADD CONSTRAINT workspace_webhooks_event_types_chk CHECK (
  cardinality(event_types) BETWEEN 1 AND 32 AND event_types <@ ARRAY[
    'turn.completed','turn.failed','turn.cancelled','turn.superseded','session.status.changed',
    'session.requiresAction','session.humanInput.requested',
    'session.notification.posted','session.notification.withdrawn',
    'session.agentCall.ringing','session.agentCall.settled',
    'usage.threshold_reached','usage.exhausted','usage.period_reset',
    'recording.started','recording.finished','recording.transcript.ready',
    'recording.transcript.failed','recording.transcript.current_changed',
    'recording.speakers.updated','recording.notes.updated','recording.deleted'
  ]::text[]
) NOT VALID;

ALTER TABLE organization_webhooks DROP CONSTRAINT organization_webhooks_event_types_chk;
ALTER TABLE organization_webhooks ADD CONSTRAINT organization_webhooks_event_types_chk CHECK (
  cardinality(event_types) BETWEEN 1 AND 32 AND event_types <@ ARRAY[
    'turn.completed','turn.failed','turn.cancelled','turn.superseded','session.status.changed',
    'session.requiresAction','session.humanInput.requested',
    'session.notification.posted','session.notification.withdrawn',
    'recording.started','recording.finished','recording.transcript.ready',
    'recording.transcript.failed','recording.transcript.current_changed',
    'recording.speakers.updated','recording.notes.updated','recording.deleted'
  ]::text[]
) NOT VALID;

DROP TRIGGER session_events_workspace_webhook_enqueue_v1 ON session_events;
CREATE TRIGGER session_events_workspace_webhook_enqueue_v1
AFTER INSERT ON session_events FOR EACH ROW
WHEN (NEW.duplicate_of_event_id IS NULL AND NEW.type IN (
  'turn.completed', 'turn.failed', 'turn.cancelled', 'turn.superseded', 'session.status.changed',
  'session.requiresAction', 'session.humanInput.requested',
  'session.notification.posted', 'session.notification.withdrawn',
  'session.agentCall.ringing', 'session.agentCall.settled'
))
EXECUTE FUNCTION opengeni_private.enqueue_workspace_webhook_deliveries_v1();

DROP TRIGGER session_events_organization_webhook_enqueue_v1 ON session_events;
CREATE TRIGGER session_events_organization_webhook_enqueue_v1
AFTER INSERT ON session_events FOR EACH ROW
WHEN (NEW.duplicate_of_event_id IS NULL AND NEW.type IN (
  'turn.completed', 'turn.failed', 'turn.cancelled', 'turn.superseded', 'session.status.changed',
  'session.requiresAction', 'session.humanInput.requested',
  'session.notification.posted', 'session.notification.withdrawn'
))
EXECUTE FUNCTION opengeni_private.enqueue_organization_webhook_deliveries_v1();

-- 1107's payload, with `turn.superseded` resolving `initiatingHuman` like the
-- other turn types.
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
  IF p_type IN ('turn.completed', 'turn.failed', 'turn.cancelled', 'turn.superseded')
    AND p_turn IS NOT NULL
  THEN
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
DO $superseded_webhook_path$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.integration_webhook_payload_v1(uuid,uuid,uuid,text,uuid,uuid,bigint,timestamptz,jsonb,text)
    SET search_path=pg_catalog,%I,pg_temp',current_schema());
END $superseded_webhook_path$;

RESET statement_timeout;
RESET lock_timeout;
