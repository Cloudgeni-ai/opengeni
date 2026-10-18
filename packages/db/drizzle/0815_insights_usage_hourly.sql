-- deployment-mode: rolling
-- Install maintenance only. Historical reads stay raw until 0818; no scan is
-- performed while CREATE TRIGGER holds its brief writer-conflicting lock.
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='30s';

-- Older runtime posture inventories require EXECUTE on all opengeni_private
-- routines. Keep new owner-only maintenance outside that runtime API catalog.
CREATE SCHEMA opengeni_insights_internal;
REVOKE ALL ON SCHEMA opengeni_insights_internal FROM PUBLIC;

CREATE TABLE opengeni_private.insights_usage_hourly_rollups (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  hour timestamptz NOT NULL,
  session_id uuid,
  provider text NOT NULL,
  model text NOT NULL,
  payer text NOT NULL,
  scheduled_task_id uuid,
  recorded_at timestamptz,
  calls bigint NOT NULL,
  "tokenKnownCalls" bigint NOT NULL,
  "cacheKnownCalls" bigint NOT NULL,
  "cacheWriteKnownCalls" bigint NOT NULL,
  "listClassKnownCalls" bigint NOT NULL,
  "uncachedInput" bigint NOT NULL,
  "cacheRead" bigint NOT NULL,
  "cacheWrite" bigint NOT NULL,
  output bigint NOT NULL,
  reasoning bigint NOT NULL,
  "listMicros" bigint NOT NULL,
  "pricedCalls" bigint NOT NULL,
  "listApproxCalls" bigint NOT NULL,
  "listUncachedInput" bigint NOT NULL,
  "listCacheRead" bigint NOT NULL,
  "listCacheWrite" bigint NOT NULL,
  "listOutput" bigint NOT NULL,
  UNIQUE NULLS NOT DISTINCT(account_id,workspace_id,hour,session_id,provider,model,payer,scheduled_task_id)
);
-- Negative partial deltas are legal until the historical hour is rebuilt.
-- They are never served: 0818 refuses activation with unfinished backfill.
CREATE TABLE opengeni_private.insights_usage_hourly_backfill (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  hour timestamptz NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  PRIMARY KEY(workspace_id,hour)
);
CREATE INDEX insights_usage_hourly_pending ON opengeni_private.insights_usage_hourly_backfill(workspace_id,hour)
  WHERE NOT completed;

CREATE FUNCTION opengeni_insights_internal.insights_usage_hour_lock(w uuid,h timestamptz) RETURNS bigint
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT hashtextextended('insights-usage-hour:'||w::text||':'||extract(epoch FROM h)::bigint::text,0)
$$;

DO $functions$
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_insights_internal.insights_usage_hourly_value(f %1$I.model_call_facts)
    RETURNS opengeni_private.insights_usage_hourly_rollups
    LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,opengeni_private AS $fn$
      SELECT ROW(f.account_id,f.workspace_id,date_trunc('hour',f.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
        f.session_id,f.provider,f.model,opengeni_private.insights_usage_payer(f.provider,f.billing_path),f.scheduled_task_id,
        f.recorded_at,1,
        CASE WHEN f.total_tokens IS NOT NULL THEN 1 ELSE 0 END,
        CASE WHEN f.input_tokens IS NOT NULL AND f.cached_tokens IS NOT NULL THEN 1 ELSE 0 END,
        CASE WHEN f.cache_write_tokens IS NOT NULL THEN 1 ELSE 0 END,
        CASE WHEN f.list_uncached_input_cost_micros IS NOT NULL THEN 1 ELSE 0 END,
        CASE WHEN f.input_tokens IS NOT NULL AND f.cached_tokens IS NOT NULL AND f.cache_write_tokens IS NOT NULL
          AND f.input_tokens>=0 AND f.cached_tokens>=0 AND f.cache_write_tokens>=0
          AND f.cached_tokens::numeric+f.cache_write_tokens::numeric<=f.input_tokens::numeric
          THEN f.input_tokens-f.cached_tokens-f.cache_write_tokens ELSE 0 END,
        coalesce(f.cached_tokens,0),coalesce(f.cache_write_tokens,0),coalesce(f.output_tokens,0),coalesce(f.reasoning_tokens,0),
        coalesce(f.estimated_provider_cost_micros,0),CASE WHEN f.estimated_provider_cost_micros IS NOT NULL THEN 1 ELSE 0 END,
        CASE WHEN f.list_cost_is_approx THEN 1 ELSE 0 END,coalesce(f.list_uncached_input_cost_micros,0),
        coalesce(f.list_cache_read_cost_micros,0),coalesce(f.list_cache_write_cost_micros,0),coalesce(f.list_output_cost_micros,0)
      )::opengeni_private.insights_usage_hourly_rollups
    $fn$;

    -- STABLE keeps ragged edges on the same snapshot as complete rollup hours.
    -- Invoker security: the scoped reader has already opened its capability.
    CREATE FUNCTION opengeni_insights_internal.insights_usage_hourly_scan(a uuid,w uuid,lo timestamptz,hi timestamptz)
    RETURNS SETOF opengeni_private.insights_usage_hourly_rollups
    LANGUAGE sql STABLE SET search_path=pg_catalog,%1$I,opengeni_private,pg_temp AS $fn$
      WITH fact_values AS MATERIALIZED(
        SELECT opengeni_insights_internal.insights_usage_hourly_value(f) v FROM %1$I.model_call_facts f
        WHERE f.account_id=a AND f.workspace_id=w AND f.occurred_at>=lo AND f.occurred_at<hi
      ) SELECT a,w,(v).hour,(v).session_id,(v).provider,(v).model,(v).payer,(v).scheduled_task_id,max((v).recorded_at),
        sum((v).calls)::bigint,sum((v)."tokenKnownCalls")::bigint,sum((v)."cacheKnownCalls")::bigint,
        sum((v)."cacheWriteKnownCalls")::bigint,sum((v)."listClassKnownCalls")::bigint,sum((v)."uncachedInput")::bigint,
        sum((v)."cacheRead")::bigint,sum((v)."cacheWrite")::bigint,sum((v).output)::bigint,sum((v).reasoning)::bigint,
        sum((v)."listMicros")::bigint,sum((v)."pricedCalls")::bigint,sum((v)."listApproxCalls")::bigint,
        sum((v)."listUncachedInput")::bigint,sum((v)."listCacheRead")::bigint,sum((v)."listCacheWrite")::bigint,sum((v)."listOutput")::bigint
      FROM fact_values GROUP BY (v).hour,(v).session_id,(v).provider,(v).model,(v).payer,(v).scheduled_task_id
    $fn$;

    -- Owner-only raw scan used for backfill and max repair.
    -- FORCE RLS remains enabled: reuse the exact tenant/actor read capability,
    -- preserving a caller's existing capability and GUCs on every exit.
    CREATE FUNCTION opengeni_insights_internal.insights_usage_hourly_raw(a uuid,w uuid,lo timestamptz,hi timestamptz)
    RETURNS SETOF opengeni_private.insights_usage_hourly_rollups
    LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,%1$I,opengeni_private,pg_temp AS $fn$
    DECLARE prior_account text:=current_setting('opengeni.account_id',true);
      prior_workspace text:=current_setting('opengeni.workspace_id',true);
      prior_cap opengeni_private.insights_fact_read_runtime_capabilities;
    BEGIN
      IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='%1$I.model_call_facts'::regclass)) THEN
        RAISE EXCEPTION 'Insights hourly raw input is owner-invoked only' USING ERRCODE='42501'; END IF;
      -- Account-only ledger rows have no fact workspace. Match the old
      -- f.workspace_id=w predicate without trying to mint a NULL capability.
      IF w IS NULL OR lo>=hi THEN RETURN; END IF;
      SELECT * INTO prior_cap FROM opengeni_private.insights_fact_read_runtime_capabilities
        WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id() AND capability_kind='model_call_facts';
      PERFORM set_config('opengeni.account_id',a::text,true),set_config('opengeni.workspace_id',w::text,true);
      INSERT INTO opengeni_private.insights_fact_read_runtime_capabilities
        (backend_pid,transaction_id,capability_kind,account_id,workspace_id,subject_id,initiating_human_subject_id)
      VALUES(pg_backend_pid(),pg_current_xact_id(),'model_call_facts',a,w,
        nullif(current_setting('opengeni.subject_id',true),''),nullif(current_setting('opengeni.initiating_human_subject_id',true),''))
      ON CONFLICT(backend_pid,transaction_id,capability_kind) DO UPDATE SET
        account_id=excluded.account_id,workspace_id=excluded.workspace_id,
        subject_id=excluded.subject_id,initiating_human_subject_id=excluded.initiating_human_subject_id;
      RETURN QUERY SELECT * FROM opengeni_insights_internal.insights_usage_hourly_scan(a,w,lo,hi);
      DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities
        WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id() AND capability_kind='model_call_facts';
      IF prior_cap.backend_pid IS NOT NULL THEN
        INSERT INTO opengeni_private.insights_fact_read_runtime_capabilities SELECT prior_cap.*;
      END IF;
      PERFORM set_config('opengeni.account_id',coalesce(prior_account,''),true),
        set_config('opengeni.workspace_id',coalesce(prior_workspace,''),true);
    EXCEPTION WHEN OTHERS THEN
      -- The subtransaction rolls back capability changes before this handler.
      PERFORM set_config('opengeni.account_id',coalesce(prior_account,''),true),
        set_config('opengeni.workspace_id',coalesce(prior_workspace,''),true);
      RAISE;
    END
    $fn$;

    CREATE FUNCTION opengeni_insights_internal.insights_usage_hourly_recompute(a uuid,w uuid,h timestamptz) RETURNS boolean
    LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,%1$I,opengeni_private,pg_temp AS $fn$
    BEGIN
      IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='%1$I.model_call_facts'::regclass)) THEN
        RAISE EXCEPTION 'Insights hourly recompute is owner-invoked only' USING ERRCODE='42501'; END IF;
      IF current_setting('transaction_isolation')<>'read committed' THEN
        RAISE EXCEPTION 'Hourly recompute requires READ COMMITTED' USING ERRCODE='25001'; END IF;
      IF h IS NULL OR NOT isfinite(h) OR h IS DISTINCT FROM date_trunc('hour',h AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' THEN
        RAISE EXCEPTION 'Expected a finite UTC hour' USING ERRCODE='22023'; END IF;
      -- Match the FK writer prefix before the hour fence. Otherwise workspace
      -- deletion could hold its parent row while waiting for our hourly lock,
      -- and our rebuilt INSERT would wait for that same parent FK lock.
      PERFORM 1 FROM %1$I.workspaces WHERE account_id=a AND id=w FOR KEY SHARE;
      IF NOT FOUND THEN RETURN true; END IF;
      PERFORM pg_advisory_xact_lock(opengeni_insights_internal.insights_usage_hour_lock(w,h));
      -- VOLATILE + READ COMMITTED: take the raw snapshot AFTER acquiring the
      -- fence, not in the statement that waited for a concurrent fact writer.
      DELETE FROM opengeni_private.insights_usage_hourly_rollups WHERE account_id=a AND workspace_id=w AND hour=h;
      INSERT INTO opengeni_private.insights_usage_hourly_rollups
        SELECT * FROM opengeni_insights_internal.insights_usage_hourly_raw(a,w,h,h+interval '1 hour');
      RETURN true;
    END
    $fn$;

    CREATE FUNCTION opengeni_insights_internal.insights_usage_hourly_delta(v opengeni_private.insights_usage_hourly_rollups,d bigint)
    RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,%1$I,opengeni_private,pg_temp AS $fn$
    DECLARE latest timestamptz; remaining bigint;
    BEGIN
      -- A workspace cascade has already removed its parent; do not resurrect
      -- a rollup through the fact table's own cascading deletes.
      IF d<0 AND NOT EXISTS(SELECT 1 FROM %1$I.workspaces WHERE id=v.workspace_id) THEN RETURN; END IF;
      INSERT INTO opengeni_private.insights_usage_hourly_rollups AS r
      SELECT v.account_id,v.workspace_id,v.hour,v.session_id,v.provider,v.model,v.payer,v.scheduled_task_id,v.recorded_at,
        d*v.calls,d*v."tokenKnownCalls",d*v."cacheKnownCalls",d*v."cacheWriteKnownCalls",d*v."listClassKnownCalls",
        d*v."uncachedInput",d*v."cacheRead",d*v."cacheWrite",d*v.output,d*v.reasoning,d*v."listMicros",d*v."pricedCalls",
        d*v."listApproxCalls",d*v."listUncachedInput",d*v."listCacheRead",d*v."listCacheWrite",d*v."listOutput"
      ON CONFLICT(account_id,workspace_id,hour,session_id,provider,model,payer,scheduled_task_id) DO UPDATE SET
        recorded_at=CASE WHEN d>0 THEN greatest(r.recorded_at,excluded.recorded_at) ELSE r.recorded_at END,
        calls=r.calls+excluded.calls,"tokenKnownCalls"=r."tokenKnownCalls"+excluded."tokenKnownCalls",
        "cacheKnownCalls"=r."cacheKnownCalls"+excluded."cacheKnownCalls",
        "cacheWriteKnownCalls"=r."cacheWriteKnownCalls"+excluded."cacheWriteKnownCalls",
        "listClassKnownCalls"=r."listClassKnownCalls"+excluded."listClassKnownCalls",
        "uncachedInput"=r."uncachedInput"+excluded."uncachedInput","cacheRead"=r."cacheRead"+excluded."cacheRead",
        "cacheWrite"=r."cacheWrite"+excluded."cacheWrite",output=r.output+excluded.output,reasoning=r.reasoning+excluded.reasoning,
        "listMicros"=r."listMicros"+excluded."listMicros","pricedCalls"=r."pricedCalls"+excluded."pricedCalls",
        "listApproxCalls"=r."listApproxCalls"+excluded."listApproxCalls",
        "listUncachedInput"=r."listUncachedInput"+excluded."listUncachedInput","listCacheRead"=r."listCacheRead"+excluded."listCacheRead",
        "listCacheWrite"=r."listCacheWrite"+excluded."listCacheWrite","listOutput"=r."listOutput"+excluded."listOutput"
      RETURNING r.recorded_at,r.calls INTO latest,remaining;
      IF d<0 THEN
        IF remaining=0 THEN
          DELETE FROM opengeni_private.insights_usage_hourly_rollups r WHERE r.account_id=v.account_id AND r.workspace_id=v.workspace_id
            AND r.hour=v.hour AND r.session_id IS NOT DISTINCT FROM v.session_id AND r.provider=v.provider AND r.model=v.model
            AND r.payer=v.payer AND r.scheduled_task_id IS NOT DISTINCT FROM v.scheduled_task_id;
        ELSIF latest<=v.recorded_at THEN
          -- The upsert holds the group row lock. A concurrent delta cannot
          -- overwrite the repaired max, including a move between groups.
          UPDATE opengeni_private.insights_usage_hourly_rollups r SET recorded_at=(
            SELECT x.recorded_at FROM opengeni_insights_internal.insights_usage_hourly_raw(v.account_id,v.workspace_id,v.hour,v.hour+interval '1 hour') x
            WHERE x.session_id IS NOT DISTINCT FROM v.session_id AND x.provider=v.provider AND x.model=v.model
              AND x.payer=v.payer AND x.scheduled_task_id IS NOT DISTINCT FROM v.scheduled_task_id
          ) WHERE r.account_id=v.account_id AND r.workspace_id=v.workspace_id AND r.hour=v.hour
            AND r.session_id IS NOT DISTINCT FROM v.session_id AND r.provider=v.provider AND r.model=v.model
            AND r.payer=v.payer AND r.scheduled_task_id IS NOT DISTINCT FROM v.scheduled_task_id;
        END IF;
      END IF;
    END
    $fn$;

    CREATE FUNCTION opengeni_insights_internal.insights_usage_hourly_maintain() RETURNS trigger
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,%1$I,opengeni_private,pg_temp AS $fn$
    DECLARE old_value opengeni_private.insights_usage_hourly_rollups; new_value opengeni_private.insights_usage_hourly_rollups;
      old_lock bigint;new_lock bigint;
    BEGIN
      IF TG_OP<>'INSERT' THEN
        old_value:=opengeni_insights_internal.insights_usage_hourly_value(OLD);
        old_lock:=opengeni_insights_internal.insights_usage_hour_lock(old_value.workspace_id,old_value.hour);
      END IF;
      IF TG_OP<>'DELETE' THEN
        new_value:=opengeni_insights_internal.insights_usage_hourly_value(NEW);
        new_lock:=opengeni_insights_internal.insights_usage_hour_lock(new_value.workspace_id,new_value.hour);
      END IF;
      IF TG_OP='UPDATE' AND old_value IS NOT DISTINCT FROM new_value THEN RETURN NULL; END IF;
      -- Deterministic ordering when an UPDATE moves across hours/workspaces.
      PERFORM pg_advisory_xact_lock_shared(least(old_lock,new_lock));
      IF old_lock IS DISTINCT FROM new_lock THEN
        PERFORM pg_advisory_xact_lock_shared(greatest(old_lock,new_lock));
      END IF;
      IF TG_OP<>'INSERT' THEN PERFORM opengeni_insights_internal.insights_usage_hourly_delta(old_value,-1); END IF;
      IF TG_OP<>'DELETE' THEN PERFORM opengeni_insights_internal.insights_usage_hourly_delta(new_value,1); END IF;
      RETURN NULL;
    END
    $fn$;
  $ddl$,current_schema());
END
$functions$;

CREATE TRIGGER insights_usage_hourly_maintain AFTER INSERT OR UPDATE OR DELETE ON model_call_facts
  FOR EACH ROW EXECUTE FUNCTION opengeni_insights_internal.insights_usage_hourly_maintain();

-- Default ACLs can admit arbitrary roles, not just opengeni_app. Strip every
-- non-owner grant on the new tables and routines, including PUBLIC.
DO $acl$
DECLARE obj record; grantee record;
BEGIN
  FOR grantee IN SELECT DISTINCT r.rolname FROM pg_namespace n
    CROSS JOIN LATERAL aclexplode(n.nspacl) acl JOIN pg_roles r ON r.oid=acl.grantee
    WHERE n.nspname='opengeni_insights_internal' AND acl.grantee<>n.nspowner LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA opengeni_insights_internal FROM %I',grantee.rolname);
  END LOOP;
  FOR obj IN SELECT c.oid,c.relowner AS owner,format('TABLE %s',c.oid::regclass) AS target,c.relacl AS acl
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='opengeni_private' AND c.relname IN('insights_usage_hourly_rollups','insights_usage_hourly_backfill')
    UNION ALL SELECT p.oid,p.proowner,format('FUNCTION %s',p.oid::regprocedure),p.proacl
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='opengeni_insights_internal' AND p.proname IN('insights_usage_hour_lock','insights_usage_hourly_value',
      'insights_usage_hourly_scan','insights_usage_hourly_raw','insights_usage_hourly_recompute','insights_usage_hourly_delta','insights_usage_hourly_maintain') LOOP
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC',obj.target);
    FOR grantee IN SELECT DISTINCT r.rolname FROM aclexplode(obj.acl) acl JOIN pg_roles r ON r.oid=acl.grantee
      WHERE acl.grantee<>obj.owner LOOP
      EXECUTE format('REVOKE ALL ON %s FROM %I',obj.target,grantee.rolname);
    END LOOP;
  END LOOP;
END
$acl$;
