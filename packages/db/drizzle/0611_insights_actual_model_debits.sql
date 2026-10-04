-- deployment-mode: rolling
-- Analytics projection only. Actual model debit entries remain immutable here:
-- no credit amount, debit writer, pricing schedule, policy or permission changes.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='10min';
CREATE TABLE opengeni_private.insights_charge_daily(
  account_id uuid NOT NULL,workspace_id uuid,day date NOT NULL,dimensions jsonb NOT NULL,
  quantity bigint NOT NULL DEFAULT 0 CHECK(quantity>=0),entries bigint NOT NULL DEFAULT 0 CHECK(entries>=0),
  CONSTRAINT insights_charge_daily_key UNIQUE NULLS NOT DISTINCT(account_id,workspace_id,day,dimensions)
);
CREATE INDEX insights_charge_daily_account_day_idx ON opengeni_private.insights_charge_daily(account_id,day,workspace_id);
CREATE TABLE opengeni_private.insights_charge_links(
  ledger_id uuid PRIMARY KEY,account_id uuid NOT NULL,workspace_id uuid,source_id text NOT NULL,
  day date NOT NULL,occurred_at timestamptz NOT NULL,dimensions jsonb NOT NULL,quantity bigint NOT NULL,
  credit_row jsonb NOT NULL
);
CREATE INDEX insights_charge_links_source_idx ON opengeni_private.insights_charge_links(account_id,workspace_id,source_id);
CREATE INDEX insights_charge_links_window_idx ON opengeni_private.insights_charge_links(account_id,workspace_id,occurred_at);

CREATE FUNCTION opengeni_private.insights_charge_dimensions(c jsonb,f jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('session_id',coalesce(f->>'session_id',CASE
    WHEN c->'metadata'->>'sessionId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN c->'metadata'->>'sessionId' END),'provider',f->>'provider','model',f->>'model',
    'billing_path','opengeni_credits','scheduled_task_id',f->>'scheduled_task_id')
$$;
CREATE FUNCTION opengeni_private.insights_charge_row(c jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('id',c->'id','account_id',c->'account_id','workspace_id',c->'workspace_id',
    'type',c->'type','source_type',c->'source_type','source_id',c->'source_id','amount_micros',c->'amount_micros',
    'occurred_at',c->'occurred_at','metadata',jsonb_build_object('sessionId',c->'metadata'->'sessionId'))
$$;
CREATE FUNCTION opengeni_private.insights_charge_delta(a uuid,w uuid,d date,k jsonb,q bigint,direction int)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,opengeni_private,pg_temp AS $$
BEGIN
  IF direction NOT IN(-1,1) OR q<0 THEN RAISE EXCEPTION 'Invalid actual charge delta' USING ERRCODE='22023';END IF;
  INSERT INTO opengeni_private.insights_charge_daily(account_id,workspace_id,day,dimensions)
    VALUES(a,w,d,k) ON CONFLICT ON CONSTRAINT insights_charge_daily_key DO NOTHING;
  UPDATE opengeni_private.insights_charge_daily SET quantity=quantity+direction*q,entries=entries+direction
    WHERE account_id=a AND workspace_id IS NOT DISTINCT FROM w AND day=d AND dimensions=k;
  DELETE FROM opengeni_private.insights_charge_daily WHERE account_id=a AND workspace_id IS NOT DISTINCT FROM w
    AND day=d AND dimensions=k AND entries=0;
END
$$;
DO $apply$
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.insights_apply_charge(c jsonb) RETURNS void LANGUAGE plpgsql
    SET search_path=pg_catalog,%1$I,opengeni_private,pg_temp AS $fn$
    DECLARE old_link opengeni_private.insights_charge_links%%ROWTYPE;
      ledger uuid:=(c->>'id')::uuid;a uuid:=(c->>'account_id')::uuid;w uuid:=(c->>'workspace_id')::uuid;
      d date:=((c->>'occurred_at')::timestamptz AT TIME ZONE 'UTC')::date;k jsonb;fact jsonb;fence bigint;
      eligible boolean:=coalesce(c->>'type'='model_usage_debit' AND c->>'source_type'='model_response'
        AND (c->>'amount_micros')::bigint<0,false);
      prior_account text:=current_setting('opengeni.account_id',true);
      prior_workspace text:=current_setting('opengeni.workspace_id',true);
    BEGIN
      SELECT * INTO old_link FROM opengeni_private.insights_charge_links WHERE ledger_id=ledger FOR UPDATE;
      IF eligible THEN
        PERFORM set_config('opengeni.account_id',a::text,true),set_config('opengeni.workspace_id',coalesce(w::text,''),true);
        IF w IS NOT NULL THEN
          INSERT INTO opengeni_private.insights_fact_read_runtime_capabilities
            (backend_pid,transaction_id,capability_kind,account_id,workspace_id,subject_id,initiating_human_subject_id)
          VALUES(pg_backend_pid(),pg_current_xact_id(),'model_call_facts',a,w,
            nullif(current_setting('opengeni.subject_id',true),''),nullif(current_setting('opengeni.initiating_human_subject_id',true),''));
          BEGIN
            IF c->>'source_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:.' THEN
              SELECT to_jsonb(f) INTO fact FROM %1$I.model_call_facts f WHERE f.account_id=a AND f.workspace_id=w
                AND f.turn_id=left(c->>'source_id',36)::uuid AND f.source_key=substr(c->>'source_id',38);
            END IF;
            DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities WHERE backend_pid=pg_backend_pid()
              AND transaction_id=pg_current_xact_id_if_assigned() AND capability_kind='model_call_facts';
          EXCEPTION WHEN OTHERS THEN
            DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities WHERE backend_pid=pg_backend_pid()
              AND transaction_id=pg_current_xact_id_if_assigned() AND capability_kind='model_call_facts';
            PERFORM set_config('opengeni.account_id',coalesce(prior_account,''),true),set_config('opengeni.workspace_id',coalesce(prior_workspace,''),true);RAISE;
          END;
        END IF;
        k:=opengeni_private.insights_charge_dimensions(c,fact);
        PERFORM set_config('opengeni.account_id',coalesce(prior_account,''),true),set_config('opengeni.workspace_id',coalesce(prior_workspace,''),true);
      END IF;
      -- Sorted group locks serialize opposing corrections, independently of
      -- the common source fence held by the two source triggers.
      FOR fence IN SELECT DISTINCT hashtextextended(value,601) FROM unnest(ARRAY[
        CASE WHEN old_link.ledger_id IS NOT NULL THEN old_link.account_id::text||':'||coalesce(old_link.workspace_id::text,'')||':'||old_link.day::text||':'||old_link.dimensions::text END,
        CASE WHEN eligible THEN a::text||':'||coalesce(w::text,'')||':'||d::text||':'||k::text END]) value
        WHERE value IS NOT NULL ORDER BY 1 LOOP PERFORM pg_advisory_xact_lock(fence);END LOOP;
      IF old_link.ledger_id IS NOT NULL THEN PERFORM opengeni_private.insights_charge_delta(
        old_link.account_id,old_link.workspace_id,old_link.day,old_link.dimensions,old_link.quantity,-1);END IF;
      IF eligible THEN
        PERFORM opengeni_private.insights_charge_delta(a,w,d,k,-(c->>'amount_micros')::bigint,1);
        INSERT INTO opengeni_private.insights_charge_links
          -- Normalize only the valid UUID prefix in the private lookup key.
          -- Source-key case and the original ledger row remain unchanged.
          VALUES(ledger,a,w,CASE WHEN c->>'source_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:.'
            THEN lower(left(c->>'source_id',36))||substr(c->>'source_id',37)
            ELSE coalesce(c->>'source_id','unmatched:'||ledger::text) END,
            d,(c->>'occurred_at')::timestamptz,k,-(c->>'amount_micros')::bigint,opengeni_private.insights_charge_row(c))
        ON CONFLICT(ledger_id) DO UPDATE SET account_id=excluded.account_id,workspace_id=excluded.workspace_id,
          source_id=excluded.source_id,day=excluded.day,occurred_at=excluded.occurred_at,dimensions=excluded.dimensions,
          quantity=excluded.quantity,credit_row=excluded.credit_row;
      ELSE DELETE FROM opengeni_private.insights_charge_links WHERE ledger_id=ledger;END IF;
    END
    $fn$;
  $ddl$,current_schema());
END
$apply$;

CREATE FUNCTION opengeni_private.maintain_insights_model_charges() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,opengeni_private,pg_temp AS $$
DECLARE old_value jsonb;new_value jsonb;value jsonb;
BEGIN
  IF TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_RELID NOT IN('credit_ledger_entries'::regclass,'model_call_facts'::regclass) THEN
    RAISE EXCEPTION 'Actual charge maintenance requires the exact source trigger' USING ERRCODE='42501';END IF;
  IF TG_OP<>'INSERT' THEN old_value:=to_jsonb(OLD);END IF;
  IF TG_OP<>'DELETE' THEN new_value:=to_jsonb(NEW);END IF;
  IF TG_TABLE_NAME='model_call_facts' AND TG_OP='UPDATE' AND
    (old_value-'recorded_at'-'priced_cost_micros'-'estimated_provider_cost_micros'-'equivalent_credit_cost_micros'-'pricing_source'-'context_contributions'
      -'input_tokens'-'output_tokens'-'cached_tokens'-'cache_write_tokens'-'reasoning_tokens'-'total_tokens'
      -'list_uncached_input_cost_micros'-'list_cache_read_cost_micros'-'list_cache_write_cost_micros'-'list_output_cost_micros'-'list_cost_is_approx')
    IS NOT DISTINCT FROM
    (new_value-'recorded_at'-'priced_cost_micros'-'estimated_provider_cost_micros'-'equivalent_credit_cost_micros'-'pricing_source'-'context_contributions'
      -'input_tokens'-'output_tokens'-'cached_tokens'-'cache_write_tokens'-'reasoning_tokens'-'total_tokens'
      -'list_uncached_input_cost_micros'-'list_cache_read_cost_micros'-'list_cache_write_cost_micros'-'list_output_cost_micros'-'list_cost_is_approx') THEN RETURN NULL;END IF;
  IF old_value IS NOT DISTINCT FROM new_value THEN RETURN NULL;END IF;
  -- No shared source fence, link or aggregate row is touched by a writer.
  -- Fact dimension changes can reattribute arbitrarily old ledger periods;
  -- invalidate that charge scope, rather than guess the fact's debit date.
  FOR value IN SELECT DISTINCT v FROM unnest(ARRAY[old_value,new_value]) v WHERE v IS NOT NULL AND
    (TG_TABLE_NAME='model_call_facts' OR v->>'type'='model_usage_debit') LOOP
    INSERT INTO opengeni_private.insights_rollup_invalidations(account_id,workspace_id,stream,day,source_id)
      VALUES((value->>'account_id')::uuid,(value->>'workspace_id')::uuid,'charges',
        CASE WHEN TG_TABLE_NAME='credit_ledger_entries' THEN
          ((value->>'occurred_at')::timestamptz AT TIME ZONE 'UTC')::date END,(value->>'id')::uuid);
  END LOOP;
  RETURN NULL;
END
$$;

DO $pin_trigger$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.maintain_insights_model_charges() SET search_path=pg_catalog,%I,opengeni_private,pg_temp',current_schema());
END
$pin_trigger$;

ALTER TABLE credit_ledger_entries NO FORCE ROW LEVEL SECURITY;
ALTER TABLE model_call_facts NO FORCE ROW LEVEL SECURITY;
CREATE TRIGGER insights_actual_debit_delta AFTER INSERT OR UPDATE OR DELETE ON credit_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.maintain_insights_model_charges();
CREATE TRIGGER insights_model_charge_dimensions AFTER INSERT OR UPDATE OR DELETE ON model_call_facts
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.maintain_insights_model_charges();
INSERT INTO opengeni_private.insights_charge_links
  SELECT c.id,c.account_id,c.workspace_id,CASE WHEN c.source_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:.'
      THEN lower(left(c.source_id,36))||substr(c.source_id,37) ELSE coalesce(c.source_id,'unmatched:'||c.id::text) END,
    (c.occurred_at AT TIME ZONE 'UTC')::date,c.occurred_at,
    opengeni_private.insights_charge_dimensions(to_jsonb(c),to_jsonb(f)),-c.amount_micros,opengeni_private.insights_charge_row(to_jsonb(c))
  FROM credit_ledger_entries c LEFT JOIN model_call_facts f ON f.account_id=c.account_id AND f.workspace_id=c.workspace_id
    AND f.turn_id=CASE WHEN c.source_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:.'
      THEN left(c.source_id,36)::uuid END AND f.source_key=substr(c.source_id,38)
  WHERE c.type='model_usage_debit' AND c.source_type='model_response' AND c.amount_micros<0;
INSERT INTO opengeni_private.insights_charge_daily
  SELECT account_id,workspace_id,day,dimensions,sum(quantity),count(*) FROM opengeni_private.insights_charge_links GROUP BY 1,2,3,4;
DO $convergence$
DECLARE source_quantity numeric;daily_quantity numeric;
BEGIN
  SELECT coalesce(-sum(amount_micros),0) INTO source_quantity FROM credit_ledger_entries
    WHERE type='model_usage_debit' AND source_type='model_response' AND amount_micros<0;
  SELECT coalesce(sum(quantity),0) INTO daily_quantity FROM opengeni_private.insights_charge_daily;
  IF source_quantity<>daily_quantity THEN RAISE EXCEPTION 'Actual model debit projection did not converge';END IF;
END
$convergence$;
ALTER TABLE credit_ledger_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE model_call_facts FORCE ROW LEVEL SECURITY;

DO $charge_window$
BEGIN
EXECUTE format($ddl$
CREATE FUNCTION opengeni_private.insights_charge_window(a uuid,w uuid,lo timestamptz,hi timestamptz,granularity text)
RETURNS TABLE(dimensions jsonb,occurred_at timestamptz,quantity bigint) LANGUAGE sql STABLE
SET search_path=pg_catalog,%1$I,opengeni_private,pg_temp AS $fn$
  WITH bounds AS(SELECT CASE WHEN lo=date_trunc('day',lo AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' THEN lo
      ELSE (date_trunc('day',lo AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC' END AS first_day,
    date_trunc('day',hi AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS last_day),
  pending AS MATERIALIZED(SELECT EXISTS(SELECT 1 FROM opengeni_private.insights_rollup_invalidations i
    WHERE i.account_id=a AND i.workspace_id IS NOT DISTINCT FROM w AND i.stream='charges'
      AND (i.day IS NULL OR (i.day>=(lo AT TIME ZONE 'UTC')::date AND
        i.day<=(hi AT TIME ZONE 'UTC')::date))) AS dirty)
  SELECT d.dimensions,d.day::timestamp AT TIME ZONE 'UTC',d.quantity FROM opengeni_private.insights_charge_daily d CROSS JOIN bounds
    WHERE NOT (SELECT dirty FROM pending) AND granularity='day' AND d.account_id=a AND d.workspace_id IS NOT DISTINCT FROM w
      AND d.day>=(first_day AT TIME ZONE 'UTC')::date AND d.day<(last_day AT TIME ZONE 'UTC')::date
  UNION ALL SELECT l.dimensions,l.occurred_at,l.quantity FROM opengeni_private.insights_charge_links l CROSS JOIN bounds
    WHERE NOT (SELECT dirty FROM pending) AND (granularity<>'day' OR first_day>=last_day) AND l.account_id=a AND l.workspace_id IS NOT DISTINCT FROM w
      AND l.occurred_at>=lo AND l.occurred_at<hi
  UNION ALL SELECT l.dimensions,l.occurred_at,l.quantity FROM opengeni_private.insights_charge_links l CROSS JOIN bounds
    WHERE NOT (SELECT dirty FROM pending) AND granularity='day' AND first_day<last_day AND l.account_id=a AND l.workspace_id IS NOT DISTINCT FROM w
      AND l.occurred_at>=lo AND l.occurred_at<first_day
  UNION ALL SELECT l.dimensions,l.occurred_at,l.quantity FROM opengeni_private.insights_charge_links l CROSS JOIN bounds
    WHERE NOT (SELECT dirty FROM pending) AND granularity='day' AND first_day<last_day AND l.account_id=a AND l.workspace_id IS NOT DISTINCT FROM w
      AND l.occurred_at>=last_day AND l.occurred_at<hi
  UNION ALL SELECT opengeni_private.insights_charge_dimensions(to_jsonb(c),to_jsonb(f)),c.occurred_at,-c.amount_micros
    FROM %1$I.credit_ledger_entries c LEFT JOIN %1$I.model_call_facts f ON f.account_id=c.account_id AND f.workspace_id=c.workspace_id
      AND f.turn_id=CASE WHEN c.source_id~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:.'
        THEN left(c.source_id,36)::uuid END AND f.source_key=substr(c.source_id,38)
    WHERE (SELECT dirty FROM pending) AND c.account_id=a AND c.workspace_id IS NOT DISTINCT FROM w
      AND c.type='model_usage_debit' AND c.source_type='model_response' AND c.amount_micros<0
      AND c.occurred_at>=lo AND c.occurred_at<hi
$fn$;
$ddl$,current_schema());
END
$charge_window$;

-- Narrow, owner-invoked source seam. It does not classify visibility, filter
-- identity, or expose raw identifiers to the app. The existing live masking
-- definer remains the sole authority and chooses this input after integration.
CREATE FUNCTION opengeni_private.insights_rollup_public_measures(m jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('calls',m->'calls','tokenKnownCalls',m->'token_known_calls',
    'cacheKnownCalls',m->'cache_known_calls','cacheWriteKnownCalls',m->'cache_write_known_calls',
    'listClassKnownCalls',m->'list_class_known_calls','uncachedInput',m->'uncached_input_tokens',
    'cacheRead',m->'cached_tokens','cacheWrite',m->'cache_write_tokens','output',m->'output_tokens',
    'reasoning',m->'reasoning_tokens','chargedMicros',0,'listMicros',m->'list_cost_micros',
    'pricedCalls',m->'list_known_calls','listApproxCalls',m->'list_approx_calls',
    'listUncachedInput',m->'list_uncached_input_cost_micros','listCacheRead',m->'list_cache_read_cost_micros',
    'listCacheWrite',m->'list_cache_write_cost_micros','listOutput',m->'list_output_cost_micros')
$$;
DO $inputs$
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.insights_rollup_amount_inputs(a uuid,w uuid,lo timestamptz,hi timestamptz,granularity text)
    RETURNS TABLE(session_id uuid,provider text,model text,payer text,scheduled_task_id uuid,
      occurred_at timestamptz,recorded_at timestamptz,m jsonb,charge_row boolean)
    -- STABLE pins dirty selection, cached rows, every raw range and ledger
    -- attribution to the calling SELECT snapshot. No source/cache/capability
    -- writes occur here; the approved outer reader establishes authority first.
    LANGUAGE plpgsql STABLE SET search_path=pg_catalog,%1$I,opengeni_private,pg_temp AS $fn$
    DECLARE first_day timestamptz;last_day timestamptz;edge record;model_granularity text;dirty_model_days date[];
    BEGIN
      IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='%1$I.model_call_facts'::regclass)) THEN
        RAISE EXCEPTION 'Insights rollup input is owner-invoked only' USING ERRCODE='42501';END IF;
      IF a IS NULL OR a IS DISTINCT FROM nullif(current_setting('opengeni.account_id',true),'')::uuid OR
        (w IS NOT NULL AND w IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id',true),'')::uuid) THEN
        RAISE EXCEPTION 'Insights rollup input requires the exact owner scope' USING ERRCODE='42501';END IF;
      IF lo IS NULL OR hi IS NULL OR NOT isfinite(lo) OR NOT isfinite(hi) OR hi<lo OR hi-lo>interval '370 days'
        OR granularity IS NULL OR granularity NOT IN('day','hour') OR (granularity='hour' AND hi-lo>interval '1 day') THEN
        RAISE EXCEPTION 'Invalid bounded Insights rollup window' USING ERRCODE='22023';END IF;
      IF lo=hi THEN RETURN;END IF;
      first_day:=CASE WHEN lo=date_trunc('day',lo AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' THEN lo
        ELSE (date_trunc('day',lo AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC' END;
      last_day:=date_trunc('day',hi AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
      model_granularity:=CASE WHEN EXISTS(SELECT 1 FROM opengeni_private.insights_rollup_invalidations i
        WHERE i.account_id=a AND i.workspace_id=w AND i.stream='model_call_facts' AND i.day IS NULL)
        THEN 'hour' ELSE granularity END;
      SELECT coalesce(array_agg(DISTINCT i.day),'{}'::date[]) INTO dirty_model_days
        FROM opengeni_private.insights_rollup_invalidations i WHERE i.account_id=a AND i.workspace_id=w
          AND i.stream='model_call_facts' AND i.day>=(first_day AT TIME ZONE 'UTC')::date
          AND i.day<(last_day AT TIME ZONE 'UTC')::date;
      RETURN QUERY SELECT (d.dimensions->>'session_id')::uuid,d.dimensions->>'provider',d.dimensions->>'model',
        opengeni_private.insights_usage_payer(d.dimensions->>'provider',d.dimensions->>'billing_path'),
        (d.dimensions->>'scheduled_task_id')::uuid,d.day::timestamp AT TIME ZONE 'UTC',d.recorded_at,
        opengeni_private.insights_rollup_public_measures(d.measures),false
        FROM opengeni_private.insights_model_daily d
        WHERE model_granularity='day' AND d.account_id=a AND d.workspace_id=w
          AND NOT(d.day=ANY(dirty_model_days))
          AND d.day>=(first_day AT TIME ZONE 'UTC')::date AND d.day<(last_day AT TIME ZONE 'UTC')::date;
      -- Bind partial edges and dirty full days as scalar index bounds. Never join facts to
      -- a set-returning edge function whose cardinality/disabled nested loops
      -- could turn a small edge into an account-history scan. Full-day windows
      -- with no pending invalidations issue no raw model query at all.
      FOR edge IN SELECT * FROM opengeni_private.insights_rollup_edge_ranges(lo,hi,model_granularity)
        UNION ALL SELECT day::timestamp AT TIME ZONE 'UTC',(day+1)::timestamp AT TIME ZONE 'UTC'
          FROM unnest(dirty_model_days) day WHERE model_granularity='day' LOOP
        -- Privacy depends on live session/root metadata, not individual model
        -- calls. Sum only the existing public grain within each UTC bucket,
        -- BEFORE the unchanged projector materializes JSON and joins metadata.
        -- Native sums avoid constructing two large JSON objects for every call.
        -- Knownness and uncached input are still computed PER FACT; never infer
        -- unknown counters by subtracting aggregates with unequal coverage.
        RETURN QUERY SELECT f.session_id,f.provider,f.model,
          opengeni_private.insights_usage_payer(f.provider,f.billing_path),f.scheduled_task_id,
          min(f.occurred_at),max(f.recorded_at),jsonb_build_object(
            'calls',count(*),'tokenKnownCalls',count(f.total_tokens),
            'cacheKnownCalls',count(*) FILTER(WHERE f.input_tokens IS NOT NULL AND f.cached_tokens IS NOT NULL),
            'cacheWriteKnownCalls',count(f.cache_write_tokens),'listClassKnownCalls',count(f.list_uncached_input_cost_micros),
            'uncachedInput',coalesce(sum(CASE WHEN f.input_tokens IS NOT NULL AND f.cached_tokens IS NOT NULL
              AND f.cache_write_tokens IS NOT NULL AND f.input_tokens>=0 AND f.cached_tokens>=0 AND f.cache_write_tokens>=0
              AND f.cached_tokens::numeric+f.cache_write_tokens::numeric<=f.input_tokens::numeric
              THEN f.input_tokens-f.cached_tokens-f.cache_write_tokens ELSE 0 END),0),
            'cacheRead',coalesce(sum(f.cached_tokens),0),'cacheWrite',coalesce(sum(f.cache_write_tokens),0),
            'output',coalesce(sum(f.output_tokens),0),'reasoning',coalesce(sum(f.reasoning_tokens),0),
            'chargedMicros',0,'listMicros',coalesce(sum(f.estimated_provider_cost_micros),0),
            'pricedCalls',count(f.estimated_provider_cost_micros),
            'listApproxCalls',count(*) FILTER(WHERE f.list_cost_is_approx),
            'listUncachedInput',coalesce(sum(f.list_uncached_input_cost_micros),0),
            'listCacheRead',coalesce(sum(f.list_cache_read_cost_micros),0),
            'listCacheWrite',coalesce(sum(f.list_cache_write_cost_micros),0),
            'listOutput',coalesce(sum(f.list_output_cost_micros),0)),false
          FROM %1$I.model_call_facts f WHERE f.account_id=a AND f.workspace_id=w
            AND f.occurred_at>=edge.since AND f.occurred_at<edge.until
          GROUP BY f.session_id,f.provider,f.model,opengeni_private.insights_usage_payer(f.provider,f.billing_path),
            f.scheduled_task_id,date_trunc(granularity,f.occurred_at AT TIME ZONE 'UTC');
      END LOOP;
      -- Ledger periods stay independent of fact periods. Collapse only equal
      -- public dimensions and UTC buckets AFTER current fact attribution,
      -- including orphan/restricted money with zero calls. Never reprice money.
      RETURN QUERY SELECT (c.dimensions->>'session_id')::uuid,c.dimensions->>'provider',c.dimensions->>'model',
        'opengeni_credits',(c.dimensions->>'scheduled_task_id')::uuid,min(c.occurred_at),null::timestamptz,
        jsonb_build_object('calls',0,'tokenKnownCalls',0,'cacheKnownCalls',0,'cacheWriteKnownCalls',0,'listClassKnownCalls',0,
          'uncachedInput',0,'cacheRead',0,'cacheWrite',0,'output',0,'reasoning',0,'chargedMicros',sum(c.quantity),
          'listMicros',0,'pricedCalls',0,'listApproxCalls',0,'listUncachedInput',0,'listCacheRead',0,'listCacheWrite',0,'listOutput',0),true
        FROM opengeni_private.insights_charge_window(a,w,lo,hi,granularity)c
        GROUP BY c.dimensions->>'session_id',c.dimensions->>'provider',c.dimensions->>'model',
          c.dimensions->>'scheduled_task_id',date_trunc(granularity,c.occurred_at AT TIME ZONE 'UTC');
    END
    $fn$;
  $ddl$,current_schema());
END
$inputs$;

-- Explicit owner maintenance, never called by a source writer or public reader.
-- A repeatable-read snapshot refreshes one scope and consumes ONLY the marks
-- visible in that snapshot. Concurrent/uncommitted marks survive, so a cache
-- can never become authoritative by accidentally acknowledging an unseen write.
-- No NO FORCE window, source-row locks, background worker or implicit pricing
-- snapshot activation. A bounded failure leaves raw fallback fully available.
DO $reconcile$
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.insights_reconcile_rollups(a uuid,w uuid,max_source_rows integer DEFAULT 100000)
    RETURNS integer LANGUAGE plpgsql VOLATILE
    SET search_path=pg_catalog,%1$I,opengeni_private,pg_temp AS $fn$
    DECLARE pending_ids uuid[];source_rows bigint;removed integer;
      prior_account text:=current_setting('opengeni.account_id',true);
      prior_workspace text:=current_setting('opengeni.workspace_id',true);
      installed_capability boolean:=false;
    BEGIN
      IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class
        WHERE oid='%1$I.model_call_facts'::regclass)) THEN
        RAISE EXCEPTION 'Insights reconciliation is schema-owner only' USING ERRCODE='42501';END IF;
      IF a IS NULL OR max_source_rows IS NULL OR max_source_rows<1 OR max_source_rows>10000000
        OR current_setting('transaction_isolation')<>'repeatable read' THEN
        RAISE EXCEPTION 'Insights reconciliation requires a bounded repeatable-read transaction' USING ERRCODE='22023';END IF;
      SELECT array_agg(id) INTO pending_ids FROM(SELECT id FROM opengeni_private.insights_rollup_invalidations
        WHERE account_id=a AND workspace_id IS NOT DISTINCT FROM w LIMIT max_source_rows+1) pending;
      IF pending_ids IS NULL THEN RETURN 0;END IF;
      IF cardinality(pending_ids)>max_source_rows THEN
        RAISE EXCEPTION 'Insights reconciliation pending budget exceeded' USING ERRCODE='54000';END IF;
      -- Serialize cache rebuilders ONLY, nonblocking. Ordinary writers never
      -- acquire this lock or touch the rebuilt rows, even inside activity gates.
      IF NOT pg_try_advisory_xact_lock(hashtextextended('insights-reconcile:'||a::text||':'||coalesce(w::text,''),610)) THEN
        RAISE EXCEPTION 'Insights cache scope is already being reconciled' USING ERRCODE='55P03';END IF;
      IF EXISTS(SELECT 1 FROM opengeni_private.insights_fact_read_runtime_capabilities
        WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id()
          AND capability_kind IN('model_call_facts','usage_events')) THEN
        RAISE EXCEPTION 'Insights reconciliation requires its own owner capability window' USING ERRCODE='22023';END IF;
      PERFORM set_config('opengeni.account_id',a::text,true),set_config('opengeni.workspace_id',coalesce(w::text,''),true);
      IF w IS NOT NULL THEN
        INSERT INTO opengeni_private.insights_fact_read_runtime_capabilities
          (backend_pid,transaction_id,capability_kind,account_id,workspace_id,subject_id,initiating_human_subject_id)
          SELECT pg_backend_pid(),pg_current_xact_id(),kind,a,w,
            nullif(current_setting('opengeni.subject_id',true),''),nullif(current_setting('opengeni.initiating_human_subject_id',true),'')
          FROM unnest(ARRAY['model_call_facts','usage_events']) kind;
        installed_capability:=true;
      END IF;
      SELECT count(*) INTO source_rows FROM(
        SELECT 1 FROM(
          SELECT 1 FROM %1$I.usage_events WHERE account_id=a AND workspace_id=w
          UNION ALL SELECT 1 FROM %1$I.model_call_facts WHERE account_id=a AND workspace_id=w
          UNION ALL SELECT 1 FROM %1$I.credit_ledger_entries WHERE account_id=a AND workspace_id IS NOT DISTINCT FROM w
        ) sources LIMIT max_source_rows+1
      ) bounded;
      IF source_rows>max_source_rows THEN
        RAISE EXCEPTION 'Insights reconciliation source budget exceeded' USING ERRCODE='54000';END IF;
      DELETE FROM opengeni_private.insights_usage_daily WHERE account_id=a AND workspace_id=w;
      DELETE FROM opengeni_private.insights_model_daily WHERE account_id=a AND workspace_id=w;
      DELETE FROM opengeni_private.insights_charge_daily WHERE account_id=a AND workspace_id IS NOT DISTINCT FROM w;
      DELETE FROM opengeni_private.insights_charge_links WHERE account_id=a AND workspace_id IS NOT DISTINCT FROM w;
      INSERT INTO opengeni_private.insights_usage_daily
        SELECT account_id,workspace_id,(occurred_at AT TIME ZONE 'UTC')::date,
          opengeni_private.insights_rollup_dimensions('usage_events',to_jsonb(u)),sum(quantity)::bigint,count(*)
        FROM %1$I.usage_events u WHERE u.account_id=a AND u.workspace_id=w GROUP BY 1,2,3,4;
      WITH normalized AS MATERIALIZED(
        SELECT account_id,workspace_id,(occurred_at AT TIME ZONE 'UTC')::date AS day,
          opengeni_private.insights_rollup_dimensions('model_call_facts',to_jsonb(f)) AS dimensions,
          opengeni_private.insights_fact_measures(to_jsonb(f)) AS measures,recorded_at,occurred_at
        FROM %1$I.model_call_facts f WHERE f.account_id=a AND f.workspace_id=w
      ),fields AS(
        SELECT account_id,workspace_id,day,dimensions,field.key,sum(field.value::bigint)::bigint AS amount
        FROM normalized CROSS JOIN LATERAL jsonb_each_text(measures) field GROUP BY 1,2,3,4,field.key
      ),grouped AS(
        SELECT account_id,workspace_id,day,dimensions,jsonb_object_agg(key,amount) AS measures FROM fields GROUP BY 1,2,3,4
      ),extrema AS(
        SELECT account_id,workspace_id,day,dimensions,min(recorded_at) AS first_recorded,max(recorded_at) AS last_recorded,
          min(occurred_at) AS first_occurred,max(occurred_at) AS last_occurred FROM normalized GROUP BY 1,2,3,4
      ) INSERT INTO opengeni_private.insights_model_daily
        SELECT g.account_id,g.workspace_id,g.day,g.dimensions,g.measures,'[]'::jsonb,
          e.last_recorded,e.first_recorded,e.first_occurred,e.last_occurred
        FROM grouped g JOIN extrema e USING(account_id,workspace_id,day,dimensions);
      INSERT INTO opengeni_private.insights_model_daily_timestamps
        SELECT account_id,workspace_id,(occurred_at AT TIME ZONE 'UTC')::date,
          opengeni_private.insights_rollup_dimensions('model_call_facts',to_jsonb(f)),recorded_at,occurred_at,count(*)
        FROM %1$I.model_call_facts f WHERE f.account_id=a AND f.workspace_id=w GROUP BY 1,2,3,4,5,6;
      WITH sources AS(
        SELECT account_id,workspace_id,(occurred_at AT TIME ZONE 'UTC')::date AS day,
          opengeni_private.insights_rollup_dimensions('model_call_facts',to_jsonb(f)) AS dimensions,
          entry->>'source' AS source,sum((entry->>'items')::bigint) AS items,
          sum((entry->>'utf8Bytes')::bigint) AS bytes,sum((entry->>'estimatedTokens')::bigint) AS tokens,count(*) AS calls
        FROM %1$I.model_call_facts f CROSS JOIN LATERAL jsonb_array_elements(
          opengeni_private.insights_fact_contributions(jsonb_build_object('context_contributions',f.context_contributions))) entry
        WHERE f.account_id=a AND f.workspace_id=w GROUP BY 1,2,3,4,5
      ),contributions AS(
        SELECT account_id,workspace_id,day,dimensions,jsonb_agg(jsonb_build_object('source',source,'items',items,
          'utf8Bytes',bytes,'estimatedTokens',tokens,'calls',calls) ORDER BY source) AS entries
        FROM sources GROUP BY 1,2,3,4
      ) UPDATE opengeni_private.insights_model_daily d SET contributions=c.entries FROM contributions c
        WHERE d.account_id=c.account_id AND d.workspace_id=c.workspace_id AND d.day=c.day AND d.dimensions=c.dimensions;
      INSERT INTO opengeni_private.insights_charge_links
        SELECT c.id,c.account_id,c.workspace_id,CASE WHEN c.source_id~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:.'
          THEN lower(left(c.source_id,36))||substr(c.source_id,37) ELSE coalesce(c.source_id,'unmatched:'||c.id::text) END,
          (c.occurred_at AT TIME ZONE 'UTC')::date,c.occurred_at,
          opengeni_private.insights_charge_dimensions(to_jsonb(c),to_jsonb(f)),-c.amount_micros,opengeni_private.insights_charge_row(to_jsonb(c))
        FROM %1$I.credit_ledger_entries c LEFT JOIN %1$I.model_call_facts f ON f.account_id=c.account_id AND f.workspace_id=c.workspace_id
          AND f.turn_id=CASE WHEN c.source_id~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:.'
            THEN left(c.source_id,36)::uuid END AND f.source_key=substr(c.source_id,38)
        WHERE c.account_id=a AND c.workspace_id IS NOT DISTINCT FROM w AND c.type='model_usage_debit'
          AND c.source_type='model_response' AND c.amount_micros<0;
      INSERT INTO opengeni_private.insights_charge_daily
        SELECT account_id,workspace_id,day,dimensions,sum(quantity),count(*) FROM opengeni_private.insights_charge_links
          WHERE account_id=a AND workspace_id IS NOT DISTINCT FROM w GROUP BY 1,2,3,4;
      DELETE FROM opengeni_private.insights_rollup_invalidations WHERE id=ANY(pending_ids);
      GET DIAGNOSTICS removed=ROW_COUNT;
      IF installed_capability THEN
        DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities WHERE backend_pid=pg_backend_pid()
          AND transaction_id=pg_current_xact_id() AND capability_kind IN('model_call_facts','usage_events');
      END IF;
      PERFORM set_config('opengeni.account_id',coalesce(prior_account,''),true),set_config('opengeni.workspace_id',coalesce(prior_workspace,''),true);
      RETURN removed;
    EXCEPTION WHEN OTHERS THEN
      IF installed_capability THEN
        DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities WHERE backend_pid=pg_backend_pid()
          AND transaction_id=pg_current_xact_id() AND capability_kind IN('model_call_facts','usage_events');
      END IF;
      PERFORM set_config('opengeni.account_id',coalesce(prior_account,''),true),set_config('opengeni.workspace_id',coalesce(prior_workspace,''),true);
      RAISE;
    END
    $fn$;
  $ddl$,current_schema());
END
$reconcile$;

DO $acl$
DECLARE target regclass;routine regprocedure;role_name text;columns text;
BEGIN
  FOREACH target IN ARRAY ARRAY['opengeni_private.insights_charge_daily'::regclass,'opengeni_private.insights_charge_links'::regclass] LOOP
    SELECT string_agg(quote_ident(attname),',') INTO columns FROM pg_attribute WHERE attrelid=target AND attnum>0 AND NOT attisdropped;
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC',target);EXECUTE format('REVOKE ALL (%s) ON TABLE %s FROM PUBLIC',columns,target);
    FOR role_name IN SELECT rolname FROM pg_roles WHERE oid<>(SELECT relowner FROM pg_class WHERE oid=target) LOOP
      EXECUTE format('REVOKE ALL ON TABLE %s FROM %I',target,role_name);EXECUTE format('REVOKE ALL (%s) ON TABLE %s FROM %I',columns,target,role_name);
    END LOOP;
  END LOOP;
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='opengeni_private' AND p.proname IN ('insights_charge_dimensions','insights_charge_row','insights_charge_delta',
      'insights_apply_charge','maintain_insights_model_charges','insights_charge_window',
      'insights_rollup_public_measures','insights_rollup_amount_inputs','insights_reconcile_rollups') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',routine);
    FOR role_name IN SELECT r.rolname FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      JOIN pg_roles r ON r.oid=acl.grantee WHERE p.oid=routine AND acl.grantee<>p.proowner LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',routine,role_name);END LOOP;
    FOR role_name IN SELECT r.rolname FROM jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) configured(value)
      JOIN pg_roles r ON r.rolname=configured.value WHERE has_table_privilege(r.rolname,format('%I.model_call_facts',current_schema()),'SELECT')
      AND has_table_privilege(r.rolname,format('%I.usage_events',current_schema()),'SELECT') LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',routine,role_name);END LOOP;
  END LOOP;
END
$acl$;
RESET statement_timeout;
RESET lock_timeout;