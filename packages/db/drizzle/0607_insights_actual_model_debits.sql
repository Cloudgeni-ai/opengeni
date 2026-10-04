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
DECLARE old_value jsonb;new_value jsonb;fence bigint;row_value record;
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
  FOR fence IN SELECT DISTINCT hashtextextended('model-charge:'||(v->>'account_id')||':'||coalesce(v->>'workspace_id','')||':'||
      CASE WHEN TG_TABLE_NAME='model_call_facts' THEN (v->>'turn_id')||':'||(v->>'source_key')
        WHEN v->>'source_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:.'
          THEN lower(left(v->>'source_id',36))||substr(v->>'source_id',37)
        ELSE coalesce(v->>'source_id','unmatched:'||(v->>'id')) END,601)
    FROM unnest(ARRAY[old_value,new_value]) v WHERE v IS NOT NULL AND
      (TG_TABLE_NAME='model_call_facts' OR v->>'type'='model_usage_debit') ORDER BY 1
    LOOP PERFORM pg_advisory_xact_lock(fence);END LOOP;
  IF TG_TABLE_NAME='credit_ledger_entries' THEN
    IF old_value->>'type'='model_usage_debit' OR new_value->>'type'='model_usage_debit' THEN
      PERFORM opengeni_private.insights_apply_charge(coalesce(new_value,jsonb_build_object('id',old_value->'id')));END IF;
  ELSE
    FOR row_value IN SELECT l.ledger_id,l.credit_row FROM opengeni_private.insights_charge_links l WHERE EXISTS(
      SELECT 1 FROM unnest(ARRAY[old_value,new_value]) v WHERE v IS NOT NULL AND
        l.account_id=(v->>'account_id')::uuid AND l.workspace_id=(v->>'workspace_id')::uuid
        AND l.source_id=(v->>'turn_id')||':'||(v->>'source_key')) ORDER BY l.ledger_id
      LOOP PERFORM opengeni_private.insights_apply_charge(row_value.credit_row);END LOOP;
  END IF;
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

CREATE FUNCTION opengeni_private.insights_charge_window(a uuid,w uuid,lo timestamptz,hi timestamptz,granularity text)
RETURNS TABLE(dimensions jsonb,occurred_at timestamptz,quantity bigint) LANGUAGE sql STABLE
SET search_path=pg_catalog,opengeni_private,pg_temp AS $$
  WITH bounds AS(SELECT CASE WHEN lo=date_trunc('day',lo AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' THEN lo
      ELSE (date_trunc('day',lo AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC' END AS first_day,
    date_trunc('day',hi AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS last_day)
  SELECT d.dimensions,d.day::timestamp AT TIME ZONE 'UTC',d.quantity FROM opengeni_private.insights_charge_daily d CROSS JOIN bounds
    WHERE granularity='day' AND d.account_id=a AND d.workspace_id IS NOT DISTINCT FROM w
      AND d.day>=(first_day AT TIME ZONE 'UTC')::date AND d.day<(last_day AT TIME ZONE 'UTC')::date
  UNION ALL SELECT l.dimensions,l.occurred_at,l.quantity FROM opengeni_private.insights_charge_links l CROSS JOIN bounds
    WHERE (granularity<>'day' OR first_day>=last_day) AND l.account_id=a AND l.workspace_id IS NOT DISTINCT FROM w
      AND l.occurred_at>=lo AND l.occurred_at<hi
  UNION ALL SELECT l.dimensions,l.occurred_at,l.quantity FROM opengeni_private.insights_charge_links l CROSS JOIN bounds
    WHERE granularity='day' AND first_day<last_day AND l.account_id=a AND l.workspace_id IS NOT DISTINCT FROM w
      AND l.occurred_at>=lo AND l.occurred_at<first_day
  UNION ALL SELECT l.dimensions,l.occurred_at,l.quantity FROM opengeni_private.insights_charge_links l CROSS JOIN bounds
    WHERE granularity='day' AND first_day<last_day AND l.account_id=a AND l.workspace_id IS NOT DISTINCT FROM w
      AND l.occurred_at>=last_day AND l.occurred_at<hi
$$;

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
    LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,%1$I,opengeni_private,pg_temp AS $fn$
    DECLARE first_day timestamptz;last_day timestamptz;edge record;
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
      RETURN QUERY SELECT (d.dimensions->>'session_id')::uuid,d.dimensions->>'provider',d.dimensions->>'model',
        opengeni_private.insights_usage_payer(d.dimensions->>'provider',d.dimensions->>'billing_path'),
        (d.dimensions->>'scheduled_task_id')::uuid,d.day::timestamp AT TIME ZONE 'UTC',d.recorded_at,
        opengeni_private.insights_rollup_public_measures(d.measures),false
        FROM opengeni_private.insights_model_daily d
        WHERE granularity='day' AND d.account_id=a AND d.workspace_id=w
          AND d.day>=(first_day AT TIME ZONE 'UTC')::date AND d.day<(last_day AT TIME ZONE 'UTC')::date;
      -- Bind each (at most two) edge as scalar index bounds. Never join facts to
      -- a set-returning edge function whose cardinality/disabled nested loops
      -- could turn a small edge into an account-history scan. Full-day windows
      -- have zero edge iterations and issue no raw model query at all.
      FOR edge IN SELECT * FROM opengeni_private.insights_rollup_edge_ranges(lo,hi,granularity) LOOP
        RETURN QUERY SELECT f.session_id,f.provider,f.model,
          opengeni_private.insights_usage_payer(f.provider,f.billing_path),f.scheduled_task_id,f.occurred_at,f.recorded_at,
          opengeni_private.insights_rollup_public_measures(opengeni_private.insights_fact_measures(to_jsonb(f))),false
          FROM %1$I.model_call_facts f WHERE f.account_id=a AND f.workspace_id=w
            AND f.occurred_at>=edge.since AND f.occurred_at<edge.until;
      END LOOP;
      RETURN QUERY SELECT (c.dimensions->>'session_id')::uuid,c.dimensions->>'provider',c.dimensions->>'model',
        'opengeni_credits',(c.dimensions->>'scheduled_task_id')::uuid,c.occurred_at,null::timestamptz,
        jsonb_build_object('calls',0,'tokenKnownCalls',0,'cacheKnownCalls',0,'cacheWriteKnownCalls',0,'listClassKnownCalls',0,
          'uncachedInput',0,'cacheRead',0,'cacheWrite',0,'output',0,'reasoning',0,'chargedMicros',c.quantity,
          'listMicros',0,'pricedCalls',0,'listApproxCalls',0,'listUncachedInput',0,'listCacheRead',0,'listCacheWrite',0,'listOutput',0),true
        FROM opengeni_private.insights_charge_window(a,w,lo,hi,granularity)c;
    END
    $fn$;
  $ddl$,current_schema());
END
$inputs$;

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
      'insights_rollup_public_measures','insights_rollup_amount_inputs') LOOP
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