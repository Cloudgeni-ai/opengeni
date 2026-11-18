-- deployment-mode: rolling
-- The Opengeni credits a turn charged, on its terminal event.
--
-- `turn.completed`, `turn.failed`, `turn.cancelled` and `turn.superseded`
-- gain `payload.usage` when the event is written:
--
--   { "creditsMicros": 41230 | null,
--     "tokens": { "input": 18200, "output": 950 },
--     "breakdown": { "model": 39100, "webSearch": 2130, "imageGeneration": 0, "other": 0 } }
--
-- It is computed here, in the transaction that writes the event, from durable
-- records only, so a worker that crashed and recovered, a new attempt, and
-- every writer of a terminal event (worker, API, SQL) report the same sum:
--   * each model call of the turn once, by its source key: its `agent.model.usage`
--     event (or a fenced attempt's `turn.event.rejected_late` audit row of it).
--     A call whose `model.cost` usage row is written counts that row; one whose
--     ledger writes are still owed (the turn's last response commits with the
--     terminal event, before its deferred settlement) counts the charges
--     recorded with it, which recovery settles exactly;
--   * the bring-your-own-key platform fee of each call (recorded charges, else
--     its ledger row), as `other`;
--   * `web_search.cost`, `image_generation.cost` and any other `.cost` usage row
--     of the turn (video generation goes to `other`, net of a refund written
--     before the turn ended), plus hosted searches recorded with a response
--     whose settlement is still owed.
-- Subscription and customer-key calls cost 0 credits apart from the fee.
-- `creditsMicros` is null when a model call of the turn has no recorded price
-- (never a false 0). `usage` is omitted when the transaction cannot read the
-- turn's records (no tenant scope), when computing it fails (the event is
-- still written), and for turns this session never ran (imported history
-- keeps what it carried). Sub-agents are separate sessions and report on
-- their own turn events.
--
-- Reads: the session_events (workspace_id, turn_id, type) index, the
-- usage_events (workspace_id, turn_id) index of 1494, and unique idempotency
-- probes. Turn webhooks carry the same `usage` in `data`.
--
-- Rolling: the previous release writes the same events and gets the field
-- added; it reads payloads as unknown and webhook `data` as an open object.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE OR REPLACE FUNCTION opengeni_private.attach_session_turn_credit_usage_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path FROM CURRENT
AS $attach$
DECLARE usage_value jsonb;
BEGIN
  IF jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object' THEN RETURN NEW; END IF;
  -- Row-level security hides every row outside the transaction's tenant
  -- scope, which would read as free: report nothing instead. So do turns this
  -- session never ran (imported history keeps what it carried).
  IF NEW.account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR NEW.workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR NOT EXISTS (
      SELECT 1 FROM session_turns
      WHERE id = NEW.turn_id AND session_id = NEW.session_id AND workspace_id = NEW.workspace_id
    )
  THEN RETURN NEW; END IF;
  -- A missing figure must never stop a turn from ending.
  BEGIN
    WITH recorded AS (
      SELECT e.sequence,
        CASE WHEN e.type = 'agent.model.usage' THEN e.payload ELSE e.payload -> 'rejectedPayload' END AS payload
      FROM session_events e
      WHERE e.workspace_id = NEW.workspace_id AND e.turn_id = NEW.turn_id AND e.session_id = NEW.session_id
        AND ((e.type = 'agent.model.usage'
            AND (e.turn_association IS NULL OR e.turn_association = 'current'))
          OR (e.type = 'turn.event.rejected_late' AND e.payload ->> 'rejectedType' = 'agent.model.usage'))
    ),
    calls AS (
      SELECT DISTINCT ON (payload ->> 'sourceKey')
        NEW.turn_id::text || ':' || (payload ->> 'sourceKey') AS source_id, payload
      FROM recorded
      WHERE jsonb_typeof(payload) = 'object' AND jsonb_typeof(payload -> 'sourceKey') = 'string'
      ORDER BY payload ->> 'sourceKey', sequence
    ),
    -- A refund (`video_generation.refund`) nets against its `.cost` row, by
    -- the credits its ledger row returned (plan credit that has no way back
    -- stays charged), else by the usage row.
    costs AS (
      SELECT
        CASE WHEN u.event_type LIKE '%.refund'
          THEN left(u.event_type, length(u.event_type) - length('.refund')) || '.cost'
          ELSE u.event_type END AS event_type,
        u.source_resource_id,
        CASE WHEN u.event_type LIKE '%.refund' THEN -coalesce((
            SELECT l.amount_micros::numeric FROM credit_ledger_entries l
            WHERE l.idempotency_key = 'credit:' || replace(u.event_type, '.', '_') || ':' || u.source_resource_id
              AND l.account_id = NEW.account_id AND l.amount_micros >= 0
          ), u.quantity::numeric)
        ELSE u.quantity::numeric END AS quantity
      FROM usage_events u
      WHERE u.workspace_id = NEW.workspace_id AND u.turn_id = NEW.turn_id AND u.session_id = NEW.session_id
        AND u.unit = 'usd_micros'
        AND (u.event_type LIKE '%.cost' OR (u.event_type LIKE '%.refund' AND u.event_type <> 'model.refund'))
    ),
    model_costs AS (
      SELECT source_resource_id, max(quantity) AS quantity FROM costs
      WHERE event_type = 'model.cost' AND source_resource_id IS NOT NULL
      GROUP BY source_resource_id
    ),
    model_calls AS (
      SELECT coalesce(c.source_id, m.source_resource_id) AS source_id, c.payload,
        m.quantity AS charged,
        (jsonb_typeof(c.payload -> 'settlement') = 'object'
          AND jsonb_typeof(c.payload -> 'settlement' -> 'chargesOpenGeniCredits') = 'boolean'
          AND jsonb_typeof(c.payload -> 'settlement' -> 'charges') = 'object') AS has_settlement
      FROM calls c FULL JOIN model_costs m ON m.source_resource_id = c.source_id
    ),
    priced AS (
      SELECT mc.source_id, mc.payload,
        coalesce(
          mc.charged,
          CASE WHEN mc.has_settlement THEN
            CASE WHEN (mc.payload -> 'settlement' ->> 'chargesOpenGeniCredits')::boolean
              AND jsonb_typeof(mc.payload -> 'settlement' -> 'charges' -> 'creditCostMicros') = 'number'
            THEN (mc.payload -> 'settlement' -> 'charges' ->> 'creditCostMicros')::numeric
            WHEN NOT (mc.payload -> 'settlement' ->> 'chargesOpenGeniCredits')::boolean THEN 0
            END
          END,
          CASE WHEN jsonb_typeof(mc.payload -> 'pricedCostMicros') = 'number'
            THEN (mc.payload ->> 'pricedCostMicros')::numeric END
        ) AS model_micros,
        CASE
          WHEN mc.has_settlement THEN
            CASE WHEN NOT (mc.payload -> 'settlement' ->> 'chargesOpenGeniCredits')::boolean
              AND jsonb_typeof(mc.payload -> 'settlement' -> 'charges' -> 'byokPlatformFeeMicros') = 'number'
            THEN (mc.payload -> 'settlement' -> 'charges' ->> 'byokPlatformFeeMicros')::numeric ELSE 0 END
          ELSE coalesce((
            SELECT -l.amount_micros::numeric FROM credit_ledger_entries l
            WHERE l.idempotency_key = 'credit:byok_platform_fee:' || mc.source_id
              AND l.account_id = NEW.account_id AND l.amount_micros < 0
          ), 0)
        END AS fee_micros,
        CASE WHEN mc.has_settlement
          AND (mc.payload -> 'settlement' ->> 'chargesOpenGeniCredits')::boolean
          AND jsonb_typeof(mc.payload -> 'settlement' -> 'charges' -> 'hostedWebSearch' -> 'creditMicros') = 'number'
          AND NOT EXISTS (
            SELECT 1 FROM usage_events hosted
            WHERE hosted.idempotency_key = 'usage:web_search.cost:hosted:' || mc.source_id
          )
        THEN (mc.payload -> 'settlement' -> 'charges' -> 'hostedWebSearch' ->> 'creditMicros')::numeric
        ELSE 0 END AS owed_search_micros,
        CASE WHEN jsonb_typeof(mc.payload -> 'inputTokens') = 'number'
          THEN (mc.payload ->> 'inputTokens')::numeric ELSE 0 END AS input_tokens,
        CASE WHEN jsonb_typeof(mc.payload -> 'outputTokens') = 'number'
          THEN (mc.payload ->> 'outputTokens')::numeric ELSE 0 END AS output_tokens
      FROM model_calls mc
    ),
    totals AS (
      SELECT
        bool_or(model_micros IS NULL) AS unpriced,
        coalesce(sum(model_micros), 0) AS model,
        coalesce(sum(fee_micros), 0) AS fees,
        coalesce(sum(owed_search_micros), 0) AS owed_search,
        coalesce(sum(input_tokens), 0) AS input_tokens,
        coalesce(sum(output_tokens), 0) AS output_tokens
      FROM priced
    ),
    tools AS (
      SELECT
        greatest(coalesce(sum(quantity) FILTER (WHERE event_type = 'web_search.cost'), 0), 0) AS web_search,
        greatest(coalesce(sum(quantity) FILTER (WHERE event_type = 'image_generation.cost'), 0), 0) AS image_generation,
        greatest(coalesce(sum(quantity) FILTER (
          WHERE event_type NOT IN ('model.cost', 'web_search.cost', 'image_generation.cost')
        ), 0), 0) AS other
      FROM costs
    )
    SELECT jsonb_build_object(
      'creditsMicros', CASE WHEN coalesce(t.unpriced, false) THEN NULL
        ELSE (t.model + tools.web_search + t.owed_search + tools.image_generation + tools.other + t.fees)::bigint END,
      'tokens', jsonb_build_object('input', t.input_tokens::bigint, 'output', t.output_tokens::bigint),
      'breakdown', jsonb_build_object(
        'model', t.model::bigint,
        'webSearch', (tools.web_search + t.owed_search)::bigint,
        'imageGeneration', tools.image_generation::bigint,
        'other', (tools.other + t.fees)::bigint
      )
    ) INTO usage_value
    FROM totals t CROSS JOIN tools;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'turn % credit usage was not attached (SQLSTATE %)', NEW.turn_id, SQLSTATE;
    usage_value := NULL;
  END;
  IF usage_value IS NOT NULL THEN
    NEW.payload := NEW.payload || jsonb_build_object('usage', usage_value);
  END IF;
  RETURN NEW;
END $attach$;
REVOKE ALL ON FUNCTION opengeni_private.attach_session_turn_credit_usage_v1() FROM PUBLIC;

DO $turn_credit_usage_path$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.attach_session_turn_credit_usage_v1()
    SET search_path=pg_catalog,%I,pg_temp', current_schema());
END $turn_credit_usage_path$;

-- BEFORE the webhook, inbox and export triggers read the row, so they see it.
CREATE TRIGGER session_events_turn_credit_usage_v1
BEFORE INSERT ON session_events FOR EACH ROW
WHEN (NEW.turn_id IS NOT NULL AND NEW.duplicate_of_event_id IS NULL AND NEW.type IN (
  'turn.completed', 'turn.failed', 'turn.cancelled', 'turn.superseded'
))
EXECUTE FUNCTION opengeni_private.attach_session_turn_credit_usage_v1();

-- 1133's payload, with the turn's `usage` in `data` for the turn types. It is
-- rebuilt from its typed fields, and added after jsonb_strip_nulls so a null
-- `creditsMicros` (unknown) survives.
CREATE OR REPLACE FUNCTION opengeni_private.integration_webhook_payload_v1(
  p_account uuid, p_workspace uuid, p_event uuid, p_type text, p_session uuid,
  p_turn uuid, p_sequence bigint, p_occurred timestamptz, p_payload jsonb,
  p_lane text DEFAULT 'workspace'
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT
AS $payload$
DECLARE workspace_value jsonb; subject_value text; human_value jsonb; data_value jsonb;
  usage_value jsonb;
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
    IF p_type IN ('turn.completed', 'turn.failed', 'turn.cancelled', 'turn.superseded')
      AND jsonb_typeof(p_payload -> 'usage') = 'object'
    THEN
      usage_value := p_payload -> 'usage';
      data_value := data_value || jsonb_build_object('usage', jsonb_build_object(
        'creditsMicros', CASE WHEN jsonb_typeof(usage_value -> 'creditsMicros') = 'number'
          THEN usage_value -> 'creditsMicros' ELSE 'null'::jsonb END,
        'tokens', jsonb_build_object(
          'input', CASE WHEN jsonb_typeof(usage_value -> 'tokens' -> 'input') = 'number'
            THEN usage_value -> 'tokens' -> 'input' ELSE '0'::jsonb END,
          'output', CASE WHEN jsonb_typeof(usage_value -> 'tokens' -> 'output') = 'number'
            THEN usage_value -> 'tokens' -> 'output' ELSE '0'::jsonb END
        ),
        'breakdown', jsonb_build_object(
          'model', CASE WHEN jsonb_typeof(usage_value -> 'breakdown' -> 'model') = 'number'
            THEN usage_value -> 'breakdown' -> 'model' ELSE '0'::jsonb END,
          'webSearch', CASE WHEN jsonb_typeof(usage_value -> 'breakdown' -> 'webSearch') = 'number'
            THEN usage_value -> 'breakdown' -> 'webSearch' ELSE '0'::jsonb END,
          'imageGeneration', CASE WHEN jsonb_typeof(usage_value -> 'breakdown' -> 'imageGeneration') = 'number'
            THEN usage_value -> 'breakdown' -> 'imageGeneration' ELSE '0'::jsonb END,
          'other', CASE WHEN jsonb_typeof(usage_value -> 'breakdown' -> 'other') = 'number'
            THEN usage_value -> 'breakdown' -> 'other' ELSE '0'::jsonb END
        )
      ));
    END IF;
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
DO $turn_credit_usage_webhook_path$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.integration_webhook_payload_v1(uuid,uuid,uuid,text,uuid,uuid,bigint,timestamptz,jsonb,text)
    SET search_path=pg_catalog,%I,pg_temp',current_schema());
END $turn_credit_usage_webhook_path$;

RESET statement_timeout;
RESET lock_timeout;
