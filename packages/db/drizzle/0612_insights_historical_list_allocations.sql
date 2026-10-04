-- deployment-mode: rolling
-- Versioned comparison weights only: never reprice a recorded total or debit.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='10min';
CREATE TABLE opengeni_private.insights_list_rate_snapshots(
  id text PRIMARY KEY CHECK(id ~ '^[0-9a-f]{64}$'),
  version text NOT NULL UNIQUE CHECK(length(version) BETWEEN 1 AND 200),
  profiles jsonb NOT NULL CHECK(jsonb_typeof(profiles)='object'),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_fact_id uuid,
  allocated_calls bigint NOT NULL DEFAULT 0 CHECK(allocated_calls>=0),
  unknown_calls bigint NOT NULL DEFAULT 0 CHECK(unknown_calls>=0),
  completed boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX insights_list_rate_snapshot_active_idx ON opengeni_private.insights_list_rate_snapshots(active) WHERE active;
CREATE FUNCTION opengeni_private.guard_insights_list_rate_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' OR ROW(NEW.id,NEW.version,NEW.profiles,NEW.created_at) IS DISTINCT FROM
    ROW(OLD.id,OLD.version,OLD.profiles,OLD.created_at) THEN
    RAISE EXCEPTION 'List catalog snapshots are immutable' USING ERRCODE='22023';END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER insights_list_rate_snapshot_immutable BEFORE UPDATE OR DELETE ON opengeni_private.insights_list_rate_snapshots
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_insights_list_rate_snapshot();
ALTER TABLE model_call_facts
  ADD COLUMN list_allocation_snapshot_id text REFERENCES opengeni_private.insights_list_rate_snapshots(id),
  ADD COLUMN list_allocation_model text,
  ADD CONSTRAINT model_call_facts_list_allocation_provenance_check CHECK(
    (list_allocation_snapshot_id IS NULL AND list_allocation_model IS NULL) OR
    (list_allocation_snapshot_id IS NOT NULL AND list_allocation_model IS NOT NULL AND list_cost_is_approx IS TRUE
      AND list_uncached_input_cost_micros IS NOT NULL));

-- Equivalent to the approved allocateRecordedModelListCostByClass helper for
-- one recorded fact: numeric integer arithmetic, not floating point/repricing.
CREATE FUNCTION opengeni_private.insights_allocate_recorded_list_classes(f jsonb,schedule jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE counters numeric[];weights numeric[]:=ARRAY[0,0,0,0]::numeric[];amounts numeric[];
  names text[]:=ARRAY['input_tokens','cached_tokens','cache_write_tokens','output_tokens'];
  rate_names text[]:=ARRAY['inputMicrosPerMillionTokens','cachedInputMicrosPerMillionTokens',
    'cacheWriteMicrosPerMillionTokens','outputMicrosPerMillionTokens'];
  pricing jsonb;target numeric;denominator numeric;rate numeric;idx int;
BEGIN
  IF f->>'estimated_provider_cost_micros' IS NULL OR f->>'estimated_provider_cost_micros' !~ '^(0|[1-9][0-9]*)$'
    OR (f->>'estimated_provider_cost_micros')::numeric>9007199254740991 THEN RETURN NULL;END IF;
  target:=(f->>'estimated_provider_cost_micros')::numeric;
  FOR idx IN 1..4 LOOP
    IF f->>names[idx] IS NULL OR f->>names[idx] !~ '^(0|[1-9][0-9]*)$'
      OR (f->>names[idx])::numeric>9007199254740991 THEN RETURN NULL;END IF;
    counters[idx]:=(f->>names[idx])::numeric;
  END LOOP;
  IF counters[2]+counters[3]>counters[1] THEN RETURN NULL;END IF;
  SELECT tier->'pricing' INTO pricing FROM jsonb_array_elements(coalesce(schedule->'inputTokenTiers','[]'::jsonb)) tier
    WHERE (tier->>'minimumInputTokens')::numeric<=counters[1] ORDER BY (tier->>'minimumInputTokens')::numeric DESC LIMIT 1;
  pricing:=coalesce(pricing,schedule->'default');
  IF pricing IS NULL THEN RETURN NULL;END IF;
  counters[1]:=counters[1]-counters[2]-counters[3];
  FOR idx IN 1..4 LOOP
    IF counters[idx]=0 THEN CONTINUE;END IF;
    IF pricing->>rate_names[idx] IS NULL OR pricing->>rate_names[idx] !~ '^(0|[1-9][0-9]*)$'
      OR (pricing->>rate_names[idx])::numeric>9007199254740991 THEN RETURN NULL;END IF;
    rate:=(pricing->>rate_names[idx])::numeric;
    weights[idx]:=counters[idx]*rate;
  END LOOP;
  SELECT sum(weight) INTO denominator FROM unnest(weights) weight;
  IF denominator=0 THEN
    IF target<>0 THEN RETURN NULL;END IF;
    amounts:=ARRAY[0,0,0,0]::numeric[];
  ELSE
    WITH rows AS(SELECT ordinality AS class_order,div(target*weight,denominator) AS base,
      mod(target*weight,denominator) AS remainder FROM unnest(weights) WITH ORDINALITY w(weight,ordinality)),
    ranked AS(SELECT *,row_number() OVER(ORDER BY remainder DESC,class_order) AS rank,
      target-sum(base) OVER() AS remaining FROM rows)
    SELECT array_agg(base+CASE WHEN rank<=remaining THEN 1 ELSE 0 END ORDER BY class_order) INTO amounts FROM ranked;
  END IF;
  RETURN jsonb_build_object('uncachedInput',amounts[1],'cacheRead',amounts[2],'cacheWrite',amounts[3],'output',amounts[4]);
END
$$;

DO $allocator$
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.allocate_insights_model_list_classes() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,opengeni_private,pg_temp AS $fn$
    DECLARE snapshot opengeni_private.insights_list_rate_snapshots%%ROWTYPE;classes jsonb;
      correction_snapshot text;
    BEGIN
      IF TG_WHEN<>'BEFORE' OR TG_LEVEL<>'ROW' OR TG_RELID<>'%1$I.model_call_facts'::regclass THEN
        RAISE EXCEPTION 'List allocation requires the exact source trigger' USING ERRCODE='42501';END IF;
      -- No private side effect here. BEFORE INSERT also runs on source conflicts
      -- that ultimately DO NOTHING, so provenance is stored only in NEW itself.
      IF TG_OP='UPDATE' AND OLD.list_allocation_snapshot_id IS NOT NULL AND NEW.list_cost_is_approx IS TRUE AND
          ROW(NEW.list_uncached_input_cost_micros,NEW.list_cache_read_cost_micros,NEW.list_cache_write_cost_micros,
            NEW.list_output_cost_micros) IS NOT DISTINCT FROM
          ROW(OLD.list_uncached_input_cost_micros,OLD.list_cache_read_cost_micros,OLD.list_cache_write_cost_micros,
            OLD.list_output_cost_micros) THEN
        IF ROW(NEW.model,NEW.provider_api,NEW.input_tokens,NEW.cached_tokens,NEW.cache_write_tokens,
          NEW.output_tokens,NEW.estimated_provider_cost_micros,NEW.pricing_source) IS NOT DISTINCT FROM
          ROW(OLD.model,OLD.provider_api,OLD.input_tokens,OLD.cached_tokens,OLD.cache_write_tokens,
            OLD.output_tokens,OLD.estimated_provider_cost_micros,OLD.pricing_source) THEN
          NEW.list_allocation_snapshot_id:=OLD.list_allocation_snapshot_id;
          NEW.list_allocation_model:=OLD.list_allocation_model;RETURN NEW;
        END IF;
        -- Correct derived history using its original immutable weights, never
        -- silently the newly active catalog. Exact caller captures are separate.
        correction_snapshot:=OLD.list_allocation_snapshot_id;
        NEW.list_uncached_input_cost_micros:=NULL;NEW.list_cache_read_cost_micros:=NULL;
        NEW.list_cache_write_cost_micros:=NULL;NEW.list_output_cost_micros:=NULL;
        NEW.list_cost_is_approx:=NULL;
      END IF;
      IF NEW.list_uncached_input_cost_micros IS NOT NULL THEN
        NEW.list_allocation_snapshot_id:=NULL;NEW.list_allocation_model:=NULL;
        RETURN NEW;
      END IF;
      NEW.list_allocation_snapshot_id:=NULL;NEW.list_allocation_model:=NULL;
      IF NEW.estimated_provider_cost_micros IS NULL OR NEW.pricing_source='gateway_reported' THEN RETURN NEW;END IF;
      -- Native Anthropic normalization historically defaulted missing counters
      -- to zero. A zero cannot prove a provider-supported absent class; there is
      -- no retained per-field provenance here. Leave ambiguous rows unknown.
      IF NEW.provider_api='anthropic-messages' AND
        (NEW.input_tokens IS NULL OR NEW.cached_tokens IS NULL OR NEW.cache_write_tokens IS NULL
          OR NEW.output_tokens IS NULL OR NEW.cached_tokens=0 OR NEW.cache_write_tokens=0
          OR NEW.output_tokens=0 OR NEW.input_tokens::numeric-NEW.cached_tokens::numeric-NEW.cache_write_tokens::numeric<=0)
        THEN RETURN NEW;END IF;
      IF correction_snapshot IS NOT NULL THEN
        SELECT * INTO snapshot FROM opengeni_private.insights_list_rate_snapshots WHERE id=correction_snapshot;
      ELSE SELECT * INTO snapshot FROM opengeni_private.insights_list_rate_snapshots WHERE active;END IF;
      IF NOT FOUND OR snapshot.profiles->NEW.model IS NULL THEN RETURN NEW;END IF;
      classes:=opengeni_private.insights_allocate_recorded_list_classes(to_jsonb(NEW),snapshot.profiles->NEW.model);
      IF classes IS NULL THEN RETURN NEW;END IF;
      NEW.list_uncached_input_cost_micros:=(classes->>'uncachedInput')::bigint;
      NEW.list_cache_read_cost_micros:=(classes->>'cacheRead')::bigint;
      NEW.list_cache_write_cost_micros:=(classes->>'cacheWrite')::bigint;
      NEW.list_output_cost_micros:=(classes->>'output')::bigint;
      NEW.list_cost_is_approx:=true;NEW.list_allocation_snapshot_id:=snapshot.id;NEW.list_allocation_model:=NEW.model;
      RETURN NEW;
    END
    $fn$;
  $ddl$,current_schema());
END
$allocator$;
CREATE TRIGGER insights_list_class_allocation BEFORE INSERT OR UPDATE ON model_call_facts
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.allocate_insights_model_list_classes();

-- Avoid charge re-attribution for these comparison-only provenance fields.
DO $charge_skip$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('opengeni_private.maintain_insights_model_charges()'::regprocedure) INTO definition;
  IF (length(definition)-length(replace(definition,'''list_cost_is_approx''','')))/length('''list_cost_is_approx''')<>2 THEN
    RAISE EXCEPTION 'Unexpected actual charge maintenance definition';END IF;
  EXECUTE replace(definition,'''list_cost_is_approx''','''list_cost_is_approx''-''list_allocation_snapshot_id''-''list_allocation_model''');
END
$charge_skip$;

DO $backfill$
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.insights_backfill_list_snapshot(snapshot_id text,batch_limit int)
    RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,%1$I,opengeni_private,pg_temp AS $fn$
    DECLARE snapshot opengeni_private.insights_list_rate_snapshots%%ROWTYPE;last_id uuid;
      allocated bigint:=0;seen bigint:=0;is_complete boolean;prior_lock text:=current_setting('lock_timeout');
    BEGIN
      IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='%1$I.model_call_facts'::regclass)) THEN
        RAISE EXCEPTION 'List backfill requires the migration owner' USING ERRCODE='42501';END IF;
      IF batch_limit IS NULL OR batch_limit NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'Invalid bounded list backfill batch' USING ERRCODE='22023';END IF;
      SELECT * INTO snapshot FROM opengeni_private.insights_list_rate_snapshots WHERE id=snapshot_id FOR UPDATE;
      IF NOT FOUND OR NOT snapshot.active THEN RAISE EXCEPTION 'List snapshot is not active' USING ERRCODE='22023';END IF;
      IF snapshot.completed THEN RETURN jsonb_build_object('allocated',0,'unknown',0,'completed',true,'cursor',snapshot.last_fact_id);END IF;
      PERFORM set_config('lock_timeout','5s',true);
      -- Per bounded transaction, never an owner scan through FORCE. The ALTER
      -- lock also fences source changes until this cursor's deltas commit.
      ALTER TABLE %1$I.model_call_facts NO FORCE ROW LEVEL SECURITY;
      WITH batch AS MATERIALIZED(SELECT id FROM %1$I.model_call_facts
        WHERE (snapshot.last_fact_id IS NULL OR id>snapshot.last_fact_id)
          AND list_uncached_input_cost_micros IS NULL AND estimated_provider_cost_micros IS NOT NULL
          AND pricing_source IS DISTINCT FROM 'gateway_reported' ORDER BY id LIMIT batch_limit),
      changed AS(UPDATE %1$I.model_call_facts f SET list_allocation_snapshot_id=NULL
        FROM batch b WHERE f.id=b.id RETURNING f.id,f.list_uncached_input_cost_micros)
      SELECT count(*),count(list_uncached_input_cost_micros),max(id::text)::uuid INTO seen,allocated,last_id FROM changed;
      IF last_id IS NULL THEN last_id:=snapshot.last_fact_id;END IF;
      SELECT NOT EXISTS(SELECT 1 FROM %1$I.model_call_facts WHERE (last_id IS NULL OR id>last_id)
        AND list_uncached_input_cost_micros IS NULL AND estimated_provider_cost_micros IS NOT NULL
        AND pricing_source IS DISTINCT FROM 'gateway_reported') INTO is_complete;
      ALTER TABLE %1$I.model_call_facts FORCE ROW LEVEL SECURITY;
      PERFORM set_config('lock_timeout',prior_lock,true);
      UPDATE opengeni_private.insights_list_rate_snapshots SET last_fact_id=last_id,completed=is_complete,
        allocated_calls=allocated_calls+allocated,unknown_calls=unknown_calls+(seen-allocated) WHERE id=snapshot_id;
      RETURN jsonb_build_object('allocated',allocated,'unknown',seen-allocated,'completed',is_complete,'cursor',last_id);
    END
    $fn$;
  $ddl$,current_schema());
END
$backfill$;

DO $acl$
DECLARE role_name text;columns text;routine regprocedure;
BEGIN
  SELECT string_agg(quote_ident(attname),',') INTO columns FROM pg_attribute
    WHERE attrelid='opengeni_private.insights_list_rate_snapshots'::regclass AND attnum>0 AND NOT attisdropped;
  REVOKE ALL ON TABLE opengeni_private.insights_list_rate_snapshots FROM PUBLIC;
  EXECUTE format('REVOKE ALL (%s) ON TABLE opengeni_private.insights_list_rate_snapshots FROM PUBLIC',columns);
  FOR role_name IN SELECT rolname FROM pg_roles WHERE oid<>(SELECT relowner FROM pg_class WHERE oid='opengeni_private.insights_list_rate_snapshots'::regclass) LOOP
    EXECUTE format('REVOKE ALL ON TABLE opengeni_private.insights_list_rate_snapshots FROM %I',role_name);
    EXECUTE format('REVOKE ALL (%s) ON TABLE opengeni_private.insights_list_rate_snapshots FROM %I',columns,role_name);
  END LOOP;
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='opengeni_private' AND p.proname IN('insights_allocate_recorded_list_classes',
      'allocate_insights_model_list_classes','insights_backfill_list_snapshot','guard_insights_list_rate_snapshot') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',routine);
    FOR role_name IN SELECT r.rolname FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      JOIN pg_roles r ON r.oid=acl.grantee WHERE p.oid=routine AND acl.grantee<>p.proowner LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',routine,role_name);END LOOP;
    FOR role_name IN SELECT r.rolname FROM jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) configured(value)
      JOIN pg_roles r ON r.rolname=configured.value WHERE has_table_privilege(r.rolname,format('%I.model_call_facts',current_schema()),'SELECT') LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',routine,role_name);END LOOP;
  END LOOP;
END
$acl$;
RESET statement_timeout;
RESET lock_timeout;