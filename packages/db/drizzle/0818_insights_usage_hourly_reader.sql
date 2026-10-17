-- deployment-mode: rolling
-- Activate only after every pre-trigger hour has been rebuilt. No application
-- role receives table access; the existing owner-invoked input and scoped
-- SECURITY DEFINER reader retain their signatures, owners and ACLs.
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='30s';
DO $reader$
DECLARE original text;updated text;bucketed text;fact_start int;ledger_start int;visibility text;grantee record;
BEGIN
  IF EXISTS(SELECT 1 FROM opengeni_private.insights_usage_hourly_backfill WHERE NOT completed) THEN
    RAISE EXCEPTION 'Insights hourly backfill is incomplete' USING ERRCODE='55000'; END IF;
  original:=pg_get_functiondef('opengeni_private.insights_raw_amount_inputs(uuid,uuid,timestamptz,timestamptz)'::regprocedure);
  fact_start:=strpos(original,'RETURN QUERY SELECT f.session_id,f.provider,f.model,');
  ledger_start:=strpos(original,'RETURN QUERY SELECT coalesce(f.session_id,CASE WHEN c.metadata');
  IF fact_start=0 OR ledger_start<=fact_start THEN
    RAISE EXCEPTION 'Insights raw input source contract changed' USING ERRCODE='55000'; END IF;
  updated:=substr(original,1,fact_start-1)||$body$
      -- Complete UTC hours use rollups; each ragged edge uses an exact raw
      -- predicate. Even a sub-hour request reads each fact exactly once.
      RETURN QUERY WITH bounds AS (
        SELECT CASE WHEN lo=date_trunc('hour',lo AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' THEN lo
          ELSE (date_trunc('hour',lo AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')+interval '1 hour' END AS first_hour,
          date_trunc('hour',hi AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS last_hour
      ), amounts AS (
        SELECT r.* FROM opengeni_private.insights_usage_hourly_rollups r CROSS JOIN bounds b
          WHERE r.account_id=a AND r.workspace_id=w AND r.hour>=b.first_hour AND r.hour<b.last_hour
        UNION ALL SELECT r.* FROM bounds b CROSS JOIN LATERAL
          opengeni_insights_internal.insights_usage_hourly_scan(a,w,lo,least(hi,b.first_hour)) r WHERE lo<b.first_hour
        UNION ALL SELECT r.* FROM bounds b CROSS JOIN LATERAL
          opengeni_insights_internal.insights_usage_hourly_scan(a,w,greatest(lo,b.last_hour),hi) r
          WHERE hi>b.last_hour AND b.last_hour>=b.first_hour
      ) SELECT r.session_id,r.provider,r.model,r.payer,r.scheduled_task_id,r.hour,r.recorded_at,
        (to_jsonb(r)-ARRAY['account_id','workspace_id','hour','session_id','provider','model','payer','scheduled_task_id','recorded_at'])
          ||jsonb_build_object('chargedMicros',0),false FROM amounts r;
      $body$||substr(original,ledger_start);
  EXECUTE updated;
  -- Daily requests need one row per session/dimension/day, not 24 JSON
  -- objects later sorted repeatedly by the response query. Aggregate typed
  -- measures before constructing any payload. Keep the four-argument entry
  -- point hourly for compatibility; only the scoped usage reader chooses day.
  bucketed:=replace(updated,'opengeni_private.insights_raw_amount_inputs(',
    'opengeni_insights_internal.insights_usage_amount_inputs(');
  bucketed:=replace(bucketed,'hi timestamp with time zone)',
    'hi timestamp with time zone, p_granularity text)');
  IF bucketed=updated OR strpos(bucketed,'p_granularity text)')=0 THEN
    RAISE EXCEPTION 'Insights input signature contract changed' USING ERRCODE='55000'; END IF;
  bucketed:=replace(bucketed,') SELECT r.session_id,r.provider,r.model,r.payer,r.scheduled_task_id,r.hour,r.recorded_at,',$aggregate$
      ), bucketed AS (
        SELECT r.account_id,r.workspace_id,
          date_trunc(p_granularity,r.hour AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hour,
          r.session_id,r.provider,r.model,r.payer,r.scheduled_task_id,max(r.recorded_at) AS recorded_at,
          sum(r.calls)::bigint AS calls,sum(r."tokenKnownCalls")::bigint AS "tokenKnownCalls",
          sum(r."cacheKnownCalls")::bigint AS "cacheKnownCalls",sum(r."cacheWriteKnownCalls")::bigint AS "cacheWriteKnownCalls",
          sum(r."listClassKnownCalls")::bigint AS "listClassKnownCalls",sum(r."uncachedInput")::bigint AS "uncachedInput",
          sum(r."cacheRead")::bigint AS "cacheRead",sum(r."cacheWrite")::bigint AS "cacheWrite",
          sum(r.output)::bigint AS output,sum(r.reasoning)::bigint AS reasoning,sum(r."listMicros")::bigint AS "listMicros",
          sum(r."pricedCalls")::bigint AS "pricedCalls",sum(r."listApproxCalls")::bigint AS "listApproxCalls",
          sum(r."listUncachedInput")::bigint AS "listUncachedInput",sum(r."listCacheRead")::bigint AS "listCacheRead",
          sum(r."listCacheWrite")::bigint AS "listCacheWrite",sum(r."listOutput")::bigint AS "listOutput"
        FROM amounts r GROUP BY r.account_id,r.workspace_id,3,r.session_id,r.provider,r.model,r.payer,r.scheduled_task_id
      ) SELECT r.session_id,r.provider,r.model,r.payer,r.scheduled_task_id,r.hour,r.recorded_at,$aggregate$);
  bucketed:=replace(bucketed,'false FROM amounts r;','false FROM bucketed r;');
  IF strpos(bucketed,'false FROM bucketed r;')=0 THEN
    RAISE EXCEPTION 'Insights typed bucket source contract changed' USING ERRCODE='55000'; END IF;
  EXECUTE bucketed;
  REVOKE ALL ON FUNCTION opengeni_insights_internal.insights_usage_amount_inputs(uuid,uuid,timestamptz,timestamptz,text) FROM PUBLIC;
  FOR grantee IN SELECT DISTINCT r.rolname FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) acl
    JOIN pg_roles r ON r.oid=acl.grantee
    WHERE p.oid='opengeni_insights_internal.insights_usage_amount_inputs(uuid,uuid,timestamptz,timestamptz,text)'::regprocedure
      AND acl.grantee<>p.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_insights_internal.insights_usage_amount_inputs(uuid,uuid,timestamptz,timestamptz,text) FROM %I',grantee.rolname);
  END LOOP;
  original:=pg_get_functiondef('opengeni_private.insights_scoped_usage_rows(uuid,uuid,timestamptz,timestamptz,text,uuid[],boolean)'::regprocedure);
  visibility:=format('%I.session_private_actor_visible(
                  s.account_id,s.workspace_id,s.owner_organization_membership_id,s.owner_subject_id)',current_schema());
  updated:=replace(original,visibility,format(
    'coalesce((s.owner_organization_membership_id::text||'':''||s.owner_subject_id)=ANY((SELECT %I.session_private_actor_visible_keys())::text[]),false)',current_schema()));
  IF updated=original THEN RAISE EXCEPTION 'Insights visibility source contract changed' USING ERRCODE='55000'; END IF;
  updated:=replace(updated,'opengeni_private.insights_raw_amount_inputs(a,w.id,p_since,p_until)',
    'opengeni_insights_internal.insights_usage_amount_inputs(a,w.id,p_since,p_until,p_granularity)');
  updated:=replace(updated,'opengeni_private.insights_raw_amount_inputs(a,null,p_since,p_until)',
    'opengeni_insights_internal.insights_usage_amount_inputs(a,null,p_since,p_until,p_granularity)');
  IF strpos(updated,'opengeni_private.insights_raw_amount_inputs(')>0 THEN
    RAISE EXCEPTION 'Insights scoped input source contract changed' USING ERRCODE='55000'; END IF;
  EXECUTE updated;
END
$reader$;
