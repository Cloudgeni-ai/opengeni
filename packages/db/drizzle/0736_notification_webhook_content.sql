-- deployment-mode: rolling
-- Enrich the existing notification event types on both webhook lanes with
-- their bounded display content and, when Opengeni notified no one, why. Never
-- copy arbitrary event extension fields, and preserve the existing scope and
-- exact-turn attribution checks. Existing queued deliveries remain unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

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
DO $notification_webhook_path$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.integration_webhook_payload_v1(uuid,uuid,uuid,text,uuid,uuid,bigint,timestamptz,jsonb,text)
    SET search_path=pg_catalog,%I,pg_temp',current_schema());
END $notification_webhook_path$;
