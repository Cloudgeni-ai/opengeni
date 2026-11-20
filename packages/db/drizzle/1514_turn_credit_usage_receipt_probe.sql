-- deployment-mode: rolling
-- Keep terminal turn credit projections scoped to the turn and its receipt keys.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

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
            -- A correlated index probe keeps receipt history out of
            -- this trigger's critical section. The OFFSETs prevent
            -- conversion to a hashed subplan over the usage table.
            WHERE hosted.idempotency_key = (
              SELECT 'usage:web_search.cost:hosted:' || mc.source_id OFFSET 0
            )
            OFFSET 0
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
DO $turn_credit_usage_path$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.attach_session_turn_credit_usage_v1()
    SET search_path=pg_catalog,%I,pg_temp', current_schema());
END $turn_credit_usage_path$;
