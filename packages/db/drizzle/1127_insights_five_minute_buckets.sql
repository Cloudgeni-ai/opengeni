-- deployment-mode: rolling
-- Insights answers short ranges (the last hour, the last three hours, the last
-- 24 hours and custom start/end instants) with 5-minute and hourly buckets.
--
-- insights_usage_amount_inputs gains a 'five_minutes' granularity. Hourly
-- rollups cannot split an hour, so that granularity reads the window's model
-- call facts directly; the reader asks for it only for windows of at most
-- three hours. insights_scoped_usage_rows accepts it for such windows, buckets
-- hidden (private, personal, restricted, deleted) amounts the same way, and
-- allows hourly buckets up to two days, matching the response contract.
-- Hidden amounts stay aggregates per kind, person, payer and workspace; a
-- 5-minute bucket reveals no more than refreshing today's hourly totals does.
--
-- Signatures, owners, grants and settings are unchanged. The previous release
-- only asks for 'day' and 'hour' within a day, which both definitions answer
-- identically.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Later migrations name the install schema at run time; the baseline wrote it
-- as a placeholder.
DO $install$
DECLARE
  data_schema text := current_schema();
  data_schema_oid text := (SELECT oid::text FROM pg_catalog.pg_namespace WHERE nspname = current_schema());
BEGIN
  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_insights_internal.insights_usage_amount_inputs(a uuid, w uuid, lo timestamp with time zone, hi timestamp with time zone, p_granularity text) RETURNS TABLE(session_id uuid, provider text, model text, payer text, scheduled_task_id uuid, occurred_at timestamp with time zone, recorded_at timestamp with time zone, m jsonb, charge_row boolean)
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
    AS $_$
    BEGIN
      -- EXECUTE alone must never expose an intermediate private identity or
      -- per-call amount. The approved definer calls this as the schema owner.
      IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='%1$s.model_call_facts'::regclass)) THEN
        RAISE EXCEPTION 'Insights input is owner-invoked only' USING ERRCODE='42501';END IF;

      IF p_granularity='five_minutes' THEN
        -- Rollups are hourly, so 5-minute buckets read each fact in the window
        -- once. Bins are absolute UTC instants, not zone-relative.
        RETURN QUERY WITH fact_values AS MATERIALIZED(
          SELECT date_bin('5 minutes'::interval,f.occurred_at,'2000-01-01 00:00:00+00'::timestamptz) AS bin,
            opengeni_insights_internal.insights_usage_hourly_value(f) v
          FROM %1$I.model_call_facts f
          WHERE f.account_id=a AND f.workspace_id=w AND f.occurred_at>=lo AND f.occurred_at<hi
        ), bucketed AS (
          SELECT fv.bin AS hour,(fv.v).session_id,(fv.v).provider,(fv.v).model,(fv.v).payer,(fv.v).scheduled_task_id,
            max((fv.v).recorded_at) AS recorded_at,
            sum((fv.v).calls)::bigint AS calls,sum((fv.v)."tokenKnownCalls")::bigint AS "tokenKnownCalls",
            sum((fv.v)."cacheKnownCalls")::bigint AS "cacheKnownCalls",sum((fv.v)."cacheWriteKnownCalls")::bigint AS "cacheWriteKnownCalls",
            sum((fv.v)."listClassKnownCalls")::bigint AS "listClassKnownCalls",sum((fv.v)."uncachedInput")::bigint AS "uncachedInput",
            sum((fv.v)."cacheRead")::bigint AS "cacheRead",sum((fv.v)."cacheWrite")::bigint AS "cacheWrite",
            sum((fv.v).output)::bigint AS output,sum((fv.v).reasoning)::bigint AS reasoning,sum((fv.v)."listMicros")::bigint AS "listMicros",
            sum((fv.v)."pricedCalls")::bigint AS "pricedCalls",sum((fv.v)."listApproxCalls")::bigint AS "listApproxCalls",
            sum((fv.v)."listUncachedInput")::bigint AS "listUncachedInput",sum((fv.v)."listCacheRead")::bigint AS "listCacheRead",
            sum((fv.v)."listCacheWrite")::bigint AS "listCacheWrite",sum((fv.v)."listOutput")::bigint AS "listOutput"
          FROM fact_values fv
          GROUP BY fv.bin,(fv.v).session_id,(fv.v).provider,(fv.v).model,(fv.v).payer,(fv.v).scheduled_task_id
        ) SELECT r.session_id,r.provider,r.model,r.payer,r.scheduled_task_id,r.hour,r.recorded_at,
          (to_jsonb(r)-ARRAY['hour','session_id','provider','model','payer','scheduled_task_id','recorded_at'])
            ||jsonb_build_object('chargedMicros',0),false FROM bucketed r;
      ELSE
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
      ) SELECT r.session_id,r.provider,r.model,r.payer,r.scheduled_task_id,r.hour,r.recorded_at,
        (to_jsonb(r)-ARRAY['account_id','workspace_id','hour','session_id','provider','model','payer','scheduled_task_id','recorded_at'])
          ||jsonb_build_object('chargedMicros',0),false FROM bucketed r;
      END IF;
      RETURN QUERY SELECT coalesce(f.session_id,CASE WHEN c.metadata->>'sessionId'~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN(c.metadata->>'sessionId')::uuid END),
        f.provider,f.model,'opengeni_credits',f.scheduled_task_id,c.occurred_at,null::timestamptz,
        jsonb_build_object('calls',0,'tokenKnownCalls',0,'cacheKnownCalls',0,'cacheWriteKnownCalls',0,'listClassKnownCalls',0,
          'uncachedInput',0,'cacheRead',0,'cacheWrite',0,'output',0,'reasoning',0,'chargedMicros',-c.amount_micros,
          'listMicros',0,'pricedCalls',0,'listApproxCalls',0,'listUncachedInput',0,'listCacheRead',0,'listCacheWrite',0,'listOutput',0),true
      FROM %1$I.credit_ledger_entries c LEFT JOIN %1$I.model_call_facts f ON f.account_id=c.account_id AND f.workspace_id=c.workspace_id
        AND f.turn_id=CASE WHEN c.source_id~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:.' THEN left(c.source_id,36)::uuid END
        AND f.source_key=substr(c.source_id,38)
      WHERE c.account_id=a AND c.workspace_id IS NOT DISTINCT FROM w AND c.type='model_usage_debit'
        AND c.source_type='model_response' AND c.amount_micros<0 AND c.occurred_at>=lo AND c.occurred_at<hi;
    END
    $_$;
  $create$, data_schema, data_schema_oid);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.insights_scoped_usage_rows(p_account uuid, p_workspace uuid, p_since timestamp with time zone, p_until timestamp with time zone, p_granularity text, p_details uuid[], p_shared boolean) RETURNS TABLE(payload jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
    SET jit TO 'off'
    SET enable_nestloop TO 'off'
    SET plan_cache_mode TO 'force_custom_plan'
    AS $$
    DECLARE a uuid;prior_workspace text:=current_setting('opengeni.workspace_id',true);prior_lifecycle text;
      subject_value text:=nullif(current_setting('opengeni.subject_id',true),'');human_value text:=nullif(current_setting('opengeni.initiating_human_subject_id',true),'');
      w record;personal_ids uuid[]:='{}';personal_owners text[]:='{}';shared_ids uuid[]:='{}';owner_index int;owner_key text;
      detail_allowed boolean;inventory uuid;
    BEGIN
      PERFORM opengeni_private.session_variable_set_attachments_protocol_v1_active();
      BEGIN a:=nullif(current_setting('opengeni.account_id',true),'')::uuid;
        IF nullif(prior_workspace,'')::uuid IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'Insights usage requires exact scope' USING ERRCODE='42501';END IF;
      EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Insights usage scope malformed' USING ERRCODE='42501';END;
      IF a IS NULL OR a IS DISTINCT FROM p_account THEN RAISE EXCEPTION 'Insights usage account mismatch' USING ERRCODE='42501';END IF;
      IF p_since IS NULL OR p_until IS NULL OR NOT isfinite(p_since) OR NOT isfinite(p_until) OR p_until<p_since
        OR p_until-p_since>interval '370 days' OR p_granularity IS NULL OR p_granularity NOT IN('day','hour','five_minutes')
        OR(p_granularity='hour' AND p_until-p_since>interval '2 days')
        OR(p_granularity='five_minutes' AND p_until-p_since>interval '3 hours') OR p_details IS NULL OR p_shared IS NULL
      THEN RAISE EXCEPTION 'Insights usage window invalid' USING ERRCODE='22023';END IF;
      IF p_until=p_since THEN RETURN;END IF;
      IF p_workspace IS NULL THEN
        SELECT coalesce(array_agg(workspace_id),'{}') INTO shared_ids FROM %1$I.list_organization_workspace_ids(a);
      END IF;
      prior_lifecycle:=current_setting('opengeni.organization_tenancy_lifecycle',true);
      PERFORM set_config('opengeni.organization_tenancy_lifecycle','organization_membership_lifecycle',true);
      BEGIN
        SELECT coalesce(array_agg(m.personal_workspace_id ORDER BY m.id),'{}'),coalesce(array_agg(m.subject_id ORDER BY m.id),'{}')
        INTO personal_ids,personal_owners FROM %1$I.organization_memberships m JOIN %1$I.workspaces pw
          ON pw.id=m.personal_workspace_id AND pw.account_id=a WHERE m.account_id=a AND m.personal_workspace_id IS NOT NULL;
      EXCEPTION WHEN OTHERS THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle',coalesce(prior_lifecycle,''),true);RAISE;END;
      PERFORM set_config('opengeni.organization_tenancy_lifecycle',coalesce(prior_lifecycle,''),true);
      IF p_workspace IS NOT NULL AND NOT p_workspace=ANY(personal_ids) THEN shared_ids:=ARRAY[p_workspace];END IF;
      BEGIN
        FOR w IN SELECT id,name FROM %1$I.workspaces WHERE account_id=a AND(p_workspace IS NULL OR id=p_workspace) ORDER BY id LOOP
          PERFORM set_config('opengeni.workspace_id',w.id::text,true);
          owner_index:=array_position(personal_ids,w.id);
          owner_key:=CASE WHEN owner_index IS NOT NULL THEN encode(sha256(convert_to(a::text||':'||personal_owners[owner_index],'UTF8')),'hex') END;
          detail_allowed:=(w.id=ANY(p_details) OR p_shared AND w.id=ANY(shared_ids))
            AND(owner_index IS NULL OR personal_owners[owner_index]=subject_value OR personal_owners[owner_index]=human_value);
          inventory:=opengeni_private.open_session_tenancy_fence_inventory(%2$s::oid);
          PERFORM set_config('opengeni.organization_tenancy_lifecycle','organization_membership_lifecycle',true);
          INSERT INTO opengeni_private.insights_fact_read_runtime_capabilities
            (backend_pid,transaction_id,capability_kind,account_id,workspace_id,subject_id,initiating_human_subject_id)
          VALUES(pg_backend_pid(),pg_current_xact_id(),'model_call_facts',a,w.id,subject_value,human_value);
          BEGIN
            RETURN QUERY WITH inventory_sessions AS MATERIALIZED(
              SELECT s.id,s.root_session_id,s.title,s.channel_id,s.owner_subject_id,s.owner_organization_membership_id,s.visibility,
                (subject_value IS NULL OR s.visibility='workspace_shared' OR coalesce((s.owner_organization_membership_id::text||':'||s.owner_subject_id)=ANY((SELECT %1$I.session_private_actor_visible_keys())::text[]),false)) AS actor_visible
              FROM %1$I.insights_audience_sessions s WHERE s.account_id=a AND s.workspace_id=w.id
            ), classified AS MATERIALIZED(
              SELECT f.*,s.id AS leaf_id,s.owner_subject_id,s.owner_organization_membership_id,s.root_session_id,
                CASE WHEN p_workspace IS NULL AND owner_index IS NOT NULL AND NOT detail_allowed THEN 'personal'
                  WHEN s.id IS NOT NULL AND s.visibility='user_private' AND(NOT s.actor_visible OR NOT detail_allowed) THEN 'private'
                  WHEN s.id IS NOT NULL AND NOT detail_allowed THEN 'restricted'
                  WHEN f.charge_row AND f.provider IS NULL THEN 'restricted'
                  WHEN (s.id IS NULL OR r.id IS NULL) AND EXISTS(SELECT 1 FROM %1$I.model_call_facts sf
          WHERE sf.account_id=a AND sf.workspace_id=w.id AND sf.session_id=f.session_id AND sf.site_id IS NOT NULL)
          THEN 'restricted' WHEN s.id IS NULL OR r.id IS NULL THEN 'deleted'
                  WHEN NOT s.actor_visible OR NOT r.actor_visible THEN 'restricted' ELSE 'item' END AS kind
              FROM opengeni_insights_internal.insights_usage_amount_inputs(a,w.id,p_since,p_until,p_granularity) f
              LEFT JOIN inventory_sessions s ON s.id=f.session_id LEFT JOIN inventory_sessions r ON r.id=s.root_session_id
            ), projected AS MATERIALIZED(
              SELECT jsonb_build_object('kind',f.kind,'occurredAt',f.occurred_at,'recordedAt',CASE WHEN f.kind='item' THEN f.recorded_at END,
                'workspaceId',CASE WHEN f.kind='item' OR(f.kind IN('restricted','service','deleted') AND w.id=ANY(shared_ids)) THEN w.id END,
                'workspaceName',CASE WHEN f.kind='item' OR(f.kind IN('restricted','service','deleted') AND w.id=ANY(shared_ids)) THEN w.name END,
                'personal',owner_index IS NOT NULL,'provider',CASE WHEN f.kind='item' THEN f.provider END,
                'model',CASE WHEN f.kind='item' THEN f.model END,'payer',f.payer,
                'rootSessionId',CASE WHEN f.kind='item' THEN f.root_session_id END,'rootTitle',CASE WHEN f.kind='item' THEN root.title END,
                'projectId',CASE WHEN f.kind='item' THEN project.id END,'projectName',CASE WHEN f.kind='item' THEN project.name END,
                'scheduleId',CASE WHEN f.kind='item' THEN task.id END,'scheduleName',CASE WHEN f.kind='item' THEN task.name END,
                'person',CASE WHEN f.kind='personal' THEN owner_key WHEN f.kind IN('item','private')
                  AND coalesce(f.owner_subject_id,f.owner_organization_membership_id::text) IS NOT NULL THEN
                    encode(sha256(convert_to(a::text||':'||coalesce(f.owner_subject_id,f.owner_organization_membership_id::text),'UTF8')),'hex') END,
                'personName',CASE WHEN f.kind IN('item','private') THEN coalesce(u.name,access.subject_label) END,
                'you',CASE WHEN f.kind='personal' THEN personal_owners[owner_index]=subject_value
                  WHEN f.kind='item' THEN f.owner_subject_id=subject_value ELSE false END,'m',f.m) AS p
              FROM classified f LEFT JOIN inventory_sessions root ON f.kind='item' AND root.id=f.root_session_id
              LEFT JOIN %1$I.channels project ON project.id=root.channel_id AND project.account_id=a AND project.workspace_id=w.id
              LEFT JOIN %1$I.scheduled_tasks task ON f.kind='item' AND task.id=f.scheduled_task_id AND task.account_id=a AND task.workspace_id=w.id
              LEFT JOIN %1$I.workspace_memberships access ON access.account_id=a AND access.workspace_id=w.id AND access.subject_id=f.owner_subject_id
              LEFT JOIN %1$I.auth_users u ON access.subject_id='user:'||u.id
            ), hidden_fields AS(
              SELECT p->>'kind' AS kind,p->>'person' AS person,p->>'payer' AS payer,p->>'workspaceId' AS workspace,
                CASE WHEN p_granularity='five_minutes'
                  THEN date_bin('5 minutes'::interval,(p->>'occurredAt')::timestamptz,'2000-01-01 00:00:00+00'::timestamptz)
                  ELSE date_trunc(p_granularity,(p->>'occurredAt')::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' END AS bucket,
                max(p->>'workspaceName') AS workspace_name,max(p->>'personName') AS name,bool_or(coalesce((p->>'you')::boolean,false)) AS you,
                field.key,sum(field.value::bigint)::bigint AS amount
              FROM projected CROSS JOIN LATERAL jsonb_each_text(p->'m') field WHERE p->>'kind'<>'item' GROUP BY 1,2,3,4,5,field.key
            ) SELECT p FROM projected WHERE p->>'kind'='item'
              UNION ALL SELECT jsonb_build_object('kind',kind,'person',person,'personName',max(name),'you',bool_or(you),
                'payer',payer,'workspaceId',workspace,'workspaceName',max(workspace_name),'occurredAt',bucket,'recordedAt',null,
                'm',jsonb_object_agg(key,amount)) FROM hidden_fields GROUP BY kind,person,payer,workspace,bucket;
            DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities WHERE backend_pid=pg_backend_pid()
              AND transaction_id=pg_current_xact_id_if_assigned() AND capability_kind='model_call_facts';
            PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory);
            PERFORM set_config('opengeni.organization_tenancy_lifecycle',coalesce(prior_lifecycle,''),true);
          EXCEPTION WHEN OTHERS THEN
            DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities WHERE backend_pid=pg_backend_pid()
              AND transaction_id=pg_current_xact_id_if_assigned() AND capability_kind='model_call_facts';
            PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory);
            PERFORM set_config('opengeni.organization_tenancy_lifecycle',coalesce(prior_lifecycle,''),true);RAISE;
          END;
        END LOOP;
        IF p_workspace IS NULL THEN RETURN QUERY
          SELECT jsonb_build_object('kind','restricted','payer','opengeni_credits','occurredAt',bucket,'m',jsonb_object_agg(key,amount))
          FROM(SELECT CASE WHEN p_granularity='five_minutes'
              THEN date_bin('5 minutes'::interval,occurred_at,'2000-01-01 00:00:00+00'::timestamptz)
              ELSE date_trunc(p_granularity,occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' END AS bucket,
            field.key,sum(field.value::bigint)::bigint AS amount FROM opengeni_insights_internal.insights_usage_amount_inputs(a,null,p_since,p_until,p_granularity)
            CROSS JOIN LATERAL jsonb_each_text(m) field GROUP BY 1,field.key) unassigned GROUP BY bucket;END IF;
        PERFORM set_config('opengeni.workspace_id',coalesce(prior_workspace,''),true);
      EXCEPTION WHEN OTHERS THEN PERFORM set_config('opengeni.workspace_id',coalesce(prior_workspace,''),true);RAISE;END;
    END
    $$;
  $create$, data_schema, data_schema_oid);
END
$install$;
