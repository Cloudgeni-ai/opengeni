-- deployment-mode: rolling
-- Additive write-maintained analytics, not a billing or authorization change.
-- Private tables are owner-only. Invoker helpers deliberately have no ambient
-- authority: EXECUTE (needed by old runtime inventories) cannot read/write them.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE opengeni_private.insights_usage_daily (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  day date NOT NULL,
  dimensions jsonb NOT NULL,
  quantity bigint NOT NULL DEFAULT 0,
  event_count bigint NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  PRIMARY KEY (account_id, workspace_id, day, dimensions)
);
CREATE INDEX insights_usage_daily_account_day_idx
  ON opengeni_private.insights_usage_daily (account_id, day, workspace_id);
CREATE TABLE opengeni_private.insights_model_daily (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  day date NOT NULL,
  dimensions jsonb NOT NULL,
  measures jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (coalesce((measures->>'calls')::bigint, 0) >= 0),
  contributions jsonb NOT NULL DEFAULT '[]'::jsonb,
  recorded_at timestamptz,
  recorded_at_min timestamptz,
  occurred_at_min timestamptz,
  occurred_at_max timestamptz,
  PRIMARY KEY (account_id, workspace_id, day, dimensions)
);
CREATE INDEX insights_model_daily_account_day_idx
  ON opengeni_private.insights_model_daily (account_id, day, workspace_id);
CREATE INDEX insights_model_daily_session_idx
  ON opengeni_private.insights_model_daily (workspace_id, (dimensions->>'session_id'), day);
CREATE TABLE opengeni_private.insights_model_daily_timestamps (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  day date NOT NULL,
  dimensions jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  occurred_at timestamptz NOT NULL,
  calls bigint NOT NULL CHECK (calls >= 0),
  PRIMARY KEY (account_id, workspace_id, day, dimensions, recorded_at, occurred_at),
  FOREIGN KEY (account_id, workspace_id, day, dimensions)
    REFERENCES opengeni_private.insights_model_daily ON DELETE CASCADE
);
CREATE INDEX insights_model_daily_occurrence_idx ON opengeni_private.insights_model_daily_timestamps
  (account_id,workspace_id,day,dimensions,occurred_at);

CREATE FUNCTION opengeni_private.insights_add_measures(a jsonb, b jsonb, sign integer)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) FROM (
    SELECT key, sum(value)::bigint AS value FROM (
      SELECT key, value::bigint AS value FROM jsonb_each_text(a)
      UNION ALL SELECT key, sign * value::bigint FROM jsonb_each_text(b)
    ) values GROUP BY key
  ) added
$$;

-- A source occurs once per call, even if a legacy NULL source repeats. Empty
-- contribution arrays still count as covered calls in the main measures.
CREATE FUNCTION opengeni_private.insights_contribution_delta(a jsonb, b jsonb, sign integer)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('source', source, 'items', items,
    'utf8Bytes', bytes, 'estimatedTokens', tokens, 'calls', calls) ORDER BY source), '[]'::jsonb)
  FROM (
    SELECT entry->>'source' AS source,
      sum(direction * (entry->>'items')::bigint)::bigint AS items,
      sum(direction * (entry->>'utf8Bytes')::bigint)::bigint AS bytes,
      sum(direction * (entry->>'estimatedTokens')::bigint)::bigint AS tokens,
      sum(direction * coalesce((entry->>'calls')::bigint, 1))::bigint AS calls
    FROM (
      SELECT entry, 1 AS direction FROM jsonb_array_elements(a) entry
      UNION ALL SELECT entry, sign FROM jsonb_array_elements(b) entry
    ) entries GROUP BY entry->>'source'
    HAVING sum(direction * coalesce((entry->>'calls')::bigint, 1)) <> 0
  ) added
$$;

CREATE FUNCTION opengeni_private.insights_fact_telemetry_known(f jsonb,all_classes boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT coalesce((f->>'input_tokens')::bigint>=0 AND (f->>'cached_tokens')::bigint>=0
    AND (f->>'cache_write_tokens')::bigint>=0
    AND (f->>'input_tokens')::numeric>=(f->>'cached_tokens')::numeric+(f->>'cache_write_tokens')::numeric
    AND (NOT all_classes OR ((f->>'output_tokens')::bigint>=0 AND (f->>'reasoning_tokens')::bigint>=0
      AND (f->>'reasoning_tokens')::bigint<=(f->>'output_tokens')::bigint)),false)
$$;

CREATE FUNCTION opengeni_private.insights_fact_measures(f jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'calls', 1, 'input_tokens', coalesce((f->>'input_tokens')::bigint, 0),
    'output_tokens', coalesce((f->>'output_tokens')::bigint, 0),
    'cached_tokens', coalesce((f->>'cached_tokens')::bigint, 0),
    'uncached_input_tokens', CASE WHEN opengeni_private.insights_fact_telemetry_known(f,false)
      THEN (f->>'input_tokens')::bigint-(f->>'cached_tokens')::bigint-(f->>'cache_write_tokens')::bigint ELSE 0 END,
    'uncached_input_known_calls', CASE WHEN opengeni_private.insights_fact_telemetry_known(f,false) THEN 1 ELSE 0 END,
    'complete_class_known_calls', CASE WHEN opengeni_private.insights_fact_telemetry_known(f,true) THEN 1 ELSE 0 END,
    'cache_write_known_calls', CASE WHEN f->>'cache_write_tokens' IS NOT NULL THEN 1 ELSE 0 END,
    'cache_input_tokens', CASE WHEN f->>'cached_tokens' IS NOT NULL AND f->>'input_tokens' IS NOT NULL
      THEN (f->>'input_tokens')::bigint ELSE 0 END,
    'cache_write_tokens', coalesce((f->>'cache_write_tokens')::bigint, 0),
    'reasoning_tokens', coalesce((f->>'reasoning_tokens')::bigint, 0),
    'total_tokens', coalesce((f->>'total_tokens')::bigint, 0),
    'token_known_calls', CASE WHEN f->>'total_tokens' IS NOT NULL THEN 1 ELSE 0 END,
    'cache_known_calls', CASE WHEN f->>'cached_tokens' IS NOT NULL AND f->>'input_tokens' IS NOT NULL THEN 1 ELSE 0 END,
    'priced_cost_micros', CASE WHEN f->>'billing_path' = 'opengeni_credits'
      THEN coalesce((f->>'priced_cost_micros')::bigint, 0) ELSE 0 END,
    'estimated_provider_cost_micros', coalesce((f->>'estimated_provider_cost_micros')::bigint, 0),
    'estimated_provider_cost_known_calls', CASE WHEN f->>'estimated_provider_cost_micros' IS NOT NULL THEN 1 ELSE 0 END,
    'equivalent_credit_cost_micros', coalesce((f->>'equivalent_credit_cost_micros')::bigint, 0),
    'equivalent_credit_cost_known_calls', CASE WHEN f->>'equivalent_credit_cost_micros' IS NOT NULL THEN 1 ELSE 0 END,
    'covered_calls', CASE WHEN f->>'context_contributions' IS NOT NULL THEN 1 ELSE 0 END,
    'list_cost_micros',coalesce((f->>'estimated_provider_cost_micros')::bigint,0),
    'list_known_calls',CASE WHEN f->>'estimated_provider_cost_micros' IS NOT NULL THEN 1 ELSE 0 END,
    'list_class_known_calls',CASE WHEN f->>'list_uncached_input_cost_micros' IS NOT NULL THEN 1 ELSE 0 END,
    'list_approx_calls',CASE WHEN (f->>'list_cost_is_approx')::boolean THEN 1 ELSE 0 END,
    'list_uncached_input_cost_micros',coalesce((f->>'list_uncached_input_cost_micros')::bigint,0),
    'list_cache_read_cost_micros',coalesce((f->>'list_cache_read_cost_micros')::bigint,0),
    'list_cache_write_cost_micros',coalesce((f->>'list_cache_write_cost_micros')::bigint,0),
    'list_output_cost_micros',coalesce((f->>'list_output_cost_micros')::bigint,0))
$$;

CREATE FUNCTION opengeni_private.insights_fact_contributions(f jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('source', source, 'items', items,
    'utf8Bytes', bytes, 'estimatedTokens', tokens, 'calls', 1) ORDER BY source), '[]'::jsonb)
  FROM (
    SELECT entry->>'source' AS source, sum((entry->>'items')::bigint)::bigint AS items,
      sum((entry->>'utf8Bytes')::bigint)::bigint AS bytes,
      sum((entry->>'estimatedTokens')::bigint)::bigint AS tokens
    FROM jsonb_array_elements(coalesce(nullif(f->'context_contributions', 'null'::jsonb), '[]'::jsonb)) entry
    GROUP BY entry->>'source'
  ) grouped
$$;

CREATE FUNCTION opengeni_private.insights_rollup_dimensions(kind text, f jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN kind = 'usage_events' THEN jsonb_build_object(
    'session_id', f->'session_id', 'event_type', f->'event_type', 'unit', f->'unit',
    'warm_group', CASE WHEN f->>'event_type' = 'sandbox.warm_seconds'
      THEN split_part(f->>'source_resource_id', ':', 1) END)
  ELSE jsonb_build_object('session_id', f->'session_id', 'provider', f->'provider',
    'model', f->'model', 'billing_path', f->'billing_path', 'scheduled_task_id', f->'scheduled_task_id') END
$$;

CREATE FUNCTION opengeni_private.insights_apply_delta(kind text, f jsonb, sign integer)
RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, opengeni_private, pg_temp
AS $$
DECLARE
  a uuid := (f->>'account_id')::uuid;
  w uuid := (f->>'workspace_id')::uuid;
  d date := ((f->>'occurred_at')::timestamptz AT TIME ZONE 'UTC')::date;
  k jsonb := opengeni_private.insights_rollup_dimensions(kind, f);
  stamp timestamptz := (f->>'recorded_at')::timestamptz;
  occurred timestamptz := (f->>'occurred_at')::timestamptz;
BEGIN
  IF sign NOT IN (-1, 1) OR kind NOT IN ('usage_events', 'model_call_facts') THEN
    RAISE EXCEPTION 'Invalid Insights delta' USING ERRCODE = '22023';
  END IF;
  IF kind = 'usage_events' THEN
    INSERT INTO opengeni_private.insights_usage_daily(account_id, workspace_id, day, dimensions)
      VALUES (a, w, d, k) ON CONFLICT DO NOTHING;
    UPDATE opengeni_private.insights_usage_daily SET
      quantity = quantity + sign * (f->>'quantity')::bigint, event_count = event_count + sign
      WHERE account_id = a AND workspace_id = w AND day = d AND dimensions = k;
    DELETE FROM opengeni_private.insights_usage_daily
      WHERE account_id = a AND workspace_id = w AND day = d AND dimensions = k AND event_count = 0;
  ELSE
    INSERT INTO opengeni_private.insights_model_daily(account_id, workspace_id, day, dimensions)
      VALUES (a, w, d, k) ON CONFLICT DO NOTHING;
    -- Serializes measures and the timestamp multiset under the SAME group row.
    PERFORM 1 FROM opengeni_private.insights_model_daily
      WHERE account_id = a AND workspace_id = w AND day = d AND dimensions = k FOR UPDATE;
    INSERT INTO opengeni_private.insights_model_daily_timestamps
      (account_id, workspace_id, day, dimensions, recorded_at, occurred_at, calls)
      VALUES (a, w, d, k, stamp, occurred, 0) ON CONFLICT DO NOTHING;
    UPDATE opengeni_private.insights_model_daily_timestamps SET calls = calls + sign
      WHERE account_id = a AND workspace_id = w AND day = d AND dimensions = k AND recorded_at = stamp AND occurred_at=occurred;
    DELETE FROM opengeni_private.insights_model_daily_timestamps
      WHERE account_id = a AND workspace_id = w AND day = d AND dimensions = k AND recorded_at=stamp AND occurred_at=occurred AND calls = 0;
    UPDATE opengeni_private.insights_model_daily SET
      measures = opengeni_private.insights_add_measures(measures, opengeni_private.insights_fact_measures(f), sign),
      contributions = opengeni_private.insights_contribution_delta(contributions,
        opengeni_private.insights_fact_contributions(f), sign),
      recorded_at = (SELECT max(t.recorded_at) FROM opengeni_private.insights_model_daily_timestamps t
        WHERE t.account_id = a AND t.workspace_id = w AND t.day = d AND t.dimensions = k),
      recorded_at_min = (SELECT min(t.recorded_at) FROM opengeni_private.insights_model_daily_timestamps t
        WHERE t.account_id=a AND t.workspace_id=w AND t.day=d AND t.dimensions=k),
      occurred_at_min = (SELECT min(t.occurred_at) FROM opengeni_private.insights_model_daily_timestamps t
        WHERE t.account_id=a AND t.workspace_id=w AND t.day=d AND t.dimensions=k),
      occurred_at_max = (SELECT max(t.occurred_at) FROM opengeni_private.insights_model_daily_timestamps t
        WHERE t.account_id=a AND t.workspace_id=w AND t.day=d AND t.dimensions=k)
      WHERE account_id = a AND workspace_id = w AND day = d AND dimensions = k;
    DELETE FROM opengeni_private.insights_model_daily
      WHERE account_id = a AND workspace_id = w AND day = d AND dimensions = k AND (measures->>'calls')::bigint = 0;
  END IF;
END
$$;

CREATE FUNCTION opengeni_private.maintain_insights_daily_rollup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, opengeni_private, pg_temp
AS $$
DECLARE old_value jsonb; new_value jsonb; fence bigint;
BEGIN
  IF TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_RELID NOT IN('usage_events'::regclass,'model_call_facts'::regclass) THEN
    RAISE EXCEPTION 'Insights maintenance requires the exact source trigger' USING ERRCODE='42501';
  END IF;
  IF TG_OP <> 'INSERT' THEN old_value := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_value := to_jsonb(NEW); END IF;
  IF old_value IS NOT DISTINCT FROM new_value THEN RETURN NULL; END IF;
  -- Sorted group fences prevent opposite dimension moves from deadlocking.
  -- These are transaction-local; rollback also rolls back every delta.
  FOR fence IN SELECT DISTINCT hashtextextended(TG_TABLE_NAME || ':' || (value->>'account_id') || ':' ||
      (value->>'workspace_id') || ':' || (((value->>'occurred_at')::timestamptz AT TIME ZONE 'UTC')::date)::text || ':' ||
      opengeni_private.insights_rollup_dimensions(TG_TABLE_NAME, value)::text, 596)
    FROM unnest(ARRAY[old_value, new_value]) value WHERE value IS NOT NULL ORDER BY 1
  LOOP PERFORM pg_advisory_xact_lock(fence); END LOOP;
  IF old_value IS NOT NULL THEN PERFORM opengeni_private.insights_apply_delta(TG_TABLE_NAME, old_value, -1); END IF;
  IF new_value IS NOT NULL THEN PERFORM opengeni_private.insights_apply_delta(TG_TABLE_NAME, new_value, 1); END IF;
  RETURN NULL;
END
$$;

DO $pin_trigger$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.maintain_insights_daily_rollup() SET search_path=pg_catalog,%I,opengeni_private,pg_temp',current_schema());
END
$pin_trigger$;

-- Historical bootstrap and convergence need the owner-only window. The source
-- locks fence concurrent writers until trigger installation + bootstrap commit.
-- The app remains RLS-bound; no authorization policy/row/check is touched.
ALTER TABLE usage_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE model_call_facts NO FORCE ROW LEVEL SECURITY;
CREATE TRIGGER insights_daily_usage_delta AFTER INSERT OR UPDATE OR DELETE ON usage_events
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.maintain_insights_daily_rollup();
CREATE TRIGGER insights_daily_model_delta AFTER INSERT OR UPDATE OR DELETE ON model_call_facts
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.maintain_insights_daily_rollup();

DO $bootstrap$
DECLARE source_count bigint; target_count bigint;
BEGIN
  -- Set-based bootstrap: never execute millions of per-row runtime deltas while
  -- holding the source locks. Empty databases take the same portable path.
  INSERT INTO opengeni_private.insights_usage_daily
    SELECT account_id, workspace_id, (occurred_at AT TIME ZONE 'UTC')::date,
      opengeni_private.insights_rollup_dimensions('usage_events', to_jsonb(u)), sum(quantity)::bigint, count(*)
    FROM usage_events u GROUP BY 1, 2, 3, 4;
  WITH normalized AS MATERIALIZED(
    SELECT account_id,workspace_id,(occurred_at AT TIME ZONE 'UTC')::date AS day,
      opengeni_private.insights_rollup_dimensions('model_call_facts',to_jsonb(f)) AS dimensions,
      opengeni_private.insights_fact_measures(to_jsonb(f)) AS measures,recorded_at,occurred_at FROM model_call_facts f
  ), fields AS(
    SELECT account_id,workspace_id,day,dimensions,field.key,sum(field.value::bigint)::bigint AS amount
    FROM normalized CROSS JOIN LATERAL jsonb_each_text(measures) field GROUP BY 1,2,3,4,field.key
  ), grouped AS(
    SELECT account_id,workspace_id,day,dimensions,jsonb_object_agg(key,amount) AS measures FROM fields GROUP BY 1,2,3,4
  ), extrema AS(
    SELECT account_id,workspace_id,day,dimensions,min(recorded_at) AS first_recorded,max(recorded_at) AS last_recorded,
      min(occurred_at) AS first_occurred,max(occurred_at) AS last_occurred FROM normalized GROUP BY 1,2,3,4
  ) INSERT INTO opengeni_private.insights_model_daily
    SELECT g.account_id,g.workspace_id,g.day,g.dimensions,g.measures,'[]'::jsonb,e.last_recorded,e.first_recorded,e.first_occurred,e.last_occurred
    FROM grouped g JOIN extrema e USING(account_id,workspace_id,day,dimensions);
  INSERT INTO opengeni_private.insights_model_daily_timestamps
    SELECT account_id, workspace_id, (occurred_at AT TIME ZONE 'UTC')::date,
      opengeni_private.insights_rollup_dimensions('model_call_facts', to_jsonb(f)), recorded_at, occurred_at, count(*)
    FROM model_call_facts f GROUP BY 1, 2, 3, 4, 5, 6;
  WITH sources AS (
    SELECT account_id, workspace_id, (occurred_at AT TIME ZONE 'UTC')::date AS day,
      opengeni_private.insights_rollup_dimensions('model_call_facts', to_jsonb(f)) AS dimensions,
      entry->>'source' AS source, sum((entry->>'items')::bigint) AS items,
      sum((entry->>'utf8Bytes')::bigint) AS bytes, sum((entry->>'estimatedTokens')::bigint) AS tokens,
      count(*) AS calls
    FROM model_call_facts f CROSS JOIN LATERAL jsonb_array_elements(
      opengeni_private.insights_fact_contributions(jsonb_build_object('context_contributions', f.context_contributions))) entry
    WHERE f.context_contributions IS NOT NULL GROUP BY 1, 2, 3, 4, 5
  ), grouped AS (
    SELECT account_id, workspace_id, day, dimensions, jsonb_agg(jsonb_build_object(
      'source', source, 'items', items, 'utf8Bytes', bytes, 'estimatedTokens', tokens, 'calls', calls)
      ORDER BY source) AS contributions FROM sources GROUP BY 1, 2, 3, 4
  ) UPDATE opengeni_private.insights_model_daily d SET contributions = g.contributions FROM grouped g
    WHERE d.account_id = g.account_id AND d.workspace_id = g.workspace_id AND d.day = g.day AND d.dimensions = g.dimensions;
  SELECT count(*) INTO source_count FROM usage_events;
  SELECT coalesce(sum(event_count), 0) INTO target_count FROM opengeni_private.insights_usage_daily;
  IF source_count <> target_count THEN RAISE EXCEPTION 'Insights usage bootstrap did not converge'; END IF;
  SELECT count(*) INTO source_count FROM model_call_facts;
  SELECT coalesce(sum((measures->>'calls')::bigint), 0) INTO target_count FROM opengeni_private.insights_model_daily;
  IF source_count <> target_count THEN RAISE EXCEPTION 'Insights model bootstrap did not converge'; END IF;
END
$bootstrap$;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
ALTER TABLE model_call_facts FORCE ROW LEVEL SECURITY;

-- No SECURITY DEFINER here: direct application calls have neither private table
-- SELECT nor a capability. Existing masked definers are the only read authority.
CREATE FUNCTION opengeni_private.insights_rollup_edge_ranges(lo timestamptz,hi timestamptz,granularity text)
RETURNS TABLE(since timestamptz,until timestamptz) LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  WITH bounds AS(SELECT CASE WHEN lo=date_trunc('day',lo AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' THEN lo
      ELSE(date_trunc('day',lo AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC' END AS first_day,
    date_trunc('day',hi AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS last_day),
  edges AS(SELECT lo AS since,CASE WHEN granularity='day' AND first_day<last_day THEN first_day ELSE hi END AS until FROM bounds
    UNION ALL SELECT last_day,hi FROM bounds WHERE granularity='day' AND first_day<last_day)
  SELECT since,until FROM edges WHERE since<until
$$;
DO $windows$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.insights_usage_window(
      p_account uuid, p_workspace uuid, p_since timestamptz, p_until timestamptz,
      p_granularity text, p_events text[], p_model_usage boolean
    ) RETURNS TABLE(account_id uuid, workspace_id uuid, session_id uuid, event_type text,
      unit text, quantity bigint, event_count bigint, occurred_at timestamptz, source_resource_id text)
    LANGUAGE sql STABLE SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $fn$
      WITH bounds AS (
        SELECT CASE WHEN p_since = date_trunc('day', p_since AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          THEN p_since ELSE (date_trunc('day', p_since AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC' END AS lo,
          date_trunc('day', p_until AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hi
      ), ledger AS (
        SELECT d.account_id, d.workspace_id, (d.dimensions->>'session_id')::uuid AS session_id,
          d.dimensions->>'event_type' AS event_type, d.dimensions->>'unit' AS unit,
          d.quantity, d.event_count, d.day::timestamp AT TIME ZONE 'UTC' AS occurred_at,
          d.dimensions->>'warm_group' AS source_resource_id
        FROM opengeni_private.insights_usage_daily d CROSS JOIN bounds
        WHERE p_granularity = 'day' AND d.account_id = p_account
          AND (p_workspace IS NULL OR d.workspace_id = p_workspace)
          AND d.day >= (lo AT TIME ZONE 'UTC')::date AND d.day < (hi AT TIME ZONE 'UTC')::date
          AND (p_events IS NULL OR d.dimensions->>'event_type' = ANY(p_events))
        UNION ALL
        SELECT u.account_id, u.workspace_id, u.session_id, u.event_type, u.unit,
          u.quantity, 1::bigint, u.occurred_at,
          CASE WHEN u.event_type = 'sandbox.warm_seconds' THEN split_part(u.source_resource_id, ':', 1) END
        FROM %1$I.usage_events u CROSS JOIN opengeni_private.insights_rollup_edge_ranges(p_since,p_until,p_granularity) edge
        WHERE u.account_id = p_account AND (p_workspace IS NULL OR u.workspace_id = p_workspace)
          AND u.occurred_at >= edge.since AND u.occurred_at < edge.until
          AND (p_events IS NULL OR u.event_type = ANY(p_events))
      ) SELECT * FROM ledger
      UNION ALL
      SELECT account_id, workspace_id, session_id, 'model.usage', 'usd_micros', quantity,
        event_count, occurred_at, null::text FROM ledger WHERE p_model_usage AND event_type = 'model.cost'
    $fn$;

    CREATE FUNCTION opengeni_private.insights_model_window(
      p_account uuid, p_workspace uuid, p_since timestamptz, p_until timestamptz,
      p_granularity text, p_provider text, p_model text
    ) RETURNS TABLE(account_id uuid, workspace_id uuid, session_id uuid, provider text, model text,
      billing_path text, scheduled_task_id uuid, occurred_at timestamptz, recorded_at timestamptz,
      input_tokens bigint, output_tokens bigint, cached_tokens bigint, cache_input_tokens bigint,
      cache_write_tokens bigint, reasoning_tokens bigint, total_tokens bigint, token_known_calls bigint,
      cache_known_calls bigint, priced_cost_micros bigint, estimated_provider_cost_micros bigint,
      estimated_provider_cost_known_calls bigint, equivalent_credit_cost_micros bigint,
      equivalent_credit_cost_known_calls bigint, calls bigint, covered_calls bigint, context_contributions jsonb,
      cache_write_known_calls bigint, uncached_input_tokens bigint)
    LANGUAGE sql STABLE SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $fn$
      WITH bounds AS (
        SELECT CASE WHEN p_since = date_trunc('day', p_since AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          THEN p_since ELSE (date_trunc('day', p_since AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC' END AS lo,
          date_trunc('day', p_until AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hi
      ), inputs AS (
        SELECT d.account_id, d.workspace_id, d.dimensions, d.day::timestamp AT TIME ZONE 'UTC' AS occurred_at,
          d.recorded_at, d.measures AS m, d.contributions AS c
        FROM opengeni_private.insights_model_daily d CROSS JOIN bounds
        WHERE p_granularity = 'day' AND d.account_id = p_account
          AND (p_workspace IS NULL OR d.workspace_id = p_workspace)
          AND d.day >= (lo AT TIME ZONE 'UTC')::date AND d.day < (hi AT TIME ZONE 'UTC')::date
          AND (p_provider IS NULL OR d.dimensions->>'provider' = p_provider)
          AND (p_model IS NULL OR d.dimensions->>'model' = p_model)
        UNION ALL
        SELECT f.account_id, f.workspace_id, opengeni_private.insights_rollup_dimensions('model_call_facts', to_jsonb(f)),
          f.occurred_at, f.recorded_at, opengeni_private.insights_fact_measures(to_jsonb(f)),
          opengeni_private.insights_fact_contributions(to_jsonb(f))
        FROM %1$I.model_call_facts f CROSS JOIN opengeni_private.insights_rollup_edge_ranges(p_since,p_until,p_granularity) edge
        WHERE f.account_id = p_account AND (p_workspace IS NULL OR f.workspace_id = p_workspace)
          AND f.occurred_at >= edge.since AND f.occurred_at < edge.until
          AND (p_provider IS NULL OR f.provider = p_provider) AND (p_model IS NULL OR f.model = p_model)
      ) SELECT account_id, workspace_id, (dimensions->>'session_id')::uuid,
        dimensions->>'provider', dimensions->>'model', dimensions->>'billing_path',
        (dimensions->>'scheduled_task_id')::uuid, occurred_at, recorded_at,
        (m->>'input_tokens')::bigint, (m->>'output_tokens')::bigint, (m->>'cached_tokens')::bigint,
        (m->>'cache_input_tokens')::bigint, (m->>'cache_write_tokens')::bigint, (m->>'reasoning_tokens')::bigint,
        (m->>'total_tokens')::bigint, (m->>'token_known_calls')::bigint, (m->>'cache_known_calls')::bigint,
        (m->>'priced_cost_micros')::bigint, (m->>'estimated_provider_cost_micros')::bigint,
        (m->>'estimated_provider_cost_known_calls')::bigint, (m->>'equivalent_credit_cost_micros')::bigint,
        (m->>'equivalent_credit_cost_known_calls')::bigint, (m->>'calls')::bigint, (m->>'covered_calls')::bigint, c,
        (m->>'cache_write_known_calls')::bigint, (m->>'uncached_input_tokens')::bigint
      FROM inputs
    $fn$;
  $ddl$, data_schema);
END
$windows$;

DO $acl$
DECLARE target regclass; routine regprocedure; role_name text; columns text;
BEGIN
  FOREACH target IN ARRAY ARRAY['opengeni_private.insights_usage_daily'::regclass,
    'opengeni_private.insights_model_daily'::regclass, 'opengeni_private.insights_model_daily_timestamps'::regclass] LOOP
    SELECT string_agg(quote_ident(attname), ',') INTO columns FROM pg_attribute
      WHERE attrelid = target AND attnum > 0 AND NOT attisdropped;
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC', target);
    EXECUTE format('REVOKE ALL (%s) ON TABLE %s FROM PUBLIC', columns, target);
    FOR role_name IN SELECT rolname FROM pg_roles WHERE oid <> (SELECT relowner FROM pg_class WHERE oid = target) LOOP
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', target, role_name);
      EXECUTE format('REVOKE ALL (%s) ON TABLE %s FROM %I', columns, target, role_name);
    END LOOP;
  END LOOP;
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'opengeni_private' AND p.proname IN
      ('insights_add_measures','insights_contribution_delta','insights_fact_telemetry_known','insights_fact_measures',
        'insights_fact_contributions','insights_rollup_dimensions','insights_apply_delta','maintain_insights_daily_rollup',
        'insights_usage_window','insights_model_window','insights_rollup_edge_ranges') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine);
    FOR role_name IN SELECT DISTINCT r.rolname FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      JOIN pg_roles r ON r.oid = acl.grantee WHERE p.oid = routine AND acl.grantee <> p.proowner LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', routine, role_name);
    END LOOP;
    FOR role_name IN SELECT r.rolname FROM jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) configured(value)
      JOIN pg_roles r ON r.rolname = configured.value
      WHERE has_table_privilege(r.rolname, format('%I.model_call_facts', current_schema()), 'SELECT')
        AND has_table_privilege(r.rolname, format('%I.usage_events', current_schema()), 'SELECT') LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', routine, role_name);
    END LOOP;
  END LOOP;
END
$acl$;

RESET statement_timeout;
RESET lock_timeout;