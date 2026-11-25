-- deployment-mode: rolling
-- Source grouping needs the accepted turn's surface. Ordinary reads retain
-- the hourly rollups. Source-aware reads aggregate the exact same amounts
-- from raw facts with one extra dimension, only for the requested windows.
-- The existing scoped definer strips surface from hidden rows. No changed
-- signatures, ACLs, tenant policies, rollup writes, or backfill.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $install$
DECLARE
  data_schema text := current_schema();
  routine regprocedure;
  definition text;
  edit record;
BEGIN
  FOR routine IN SELECT unnest(ARRAY[
    'opengeni_insights_internal.insights_usage_amount_inputs(uuid,uuid,timestamptz,timestamptz,text)'::regprocedure,
    'opengeni_private.insights_scoped_usage_rows(uuid,uuid,timestamptz,timestamptz,text,uuid[],boolean)'::regprocedure,
    'opengeni_private.insights_scoped_calls_rows(uuid,uuid,timestamptz,timestamptz,jsonb,timestamptz,uuid,integer,uuid[],boolean)'::regprocedure
  ]) LOOP
    definition := pg_get_functiondef(routine);
    FOR edit IN SELECT * FROM (VALUES
      (1, $old$    BEGIN
      -- EXECUTE alone$old$, $new$    DECLARE source_aware boolean := right(p_granularity, 7) = ':source';
    BEGIN
      p_granularity := split_part(p_granularity, ':', 1);
      -- EXECUTE alone$new$),
      (1, $old$IF p_granularity='five_minutes' THEN$old$, $new$IF p_granularity='five_minutes' OR source_aware THEN$new$),
      (1, $old$SELECT date_bin('5 minutes'::interval,f.occurred_at,'2000-01-01 00:00:00+00'::timestamptz) AS bin,
            opengeni_insights_internal.insights_usage_hourly_value(f) v
          FROM %1$I.model_call_facts f$old$, $new$SELECT CASE WHEN p_granularity='five_minutes'
            THEN date_bin('5 minutes'::interval,f.occurred_at,'2000-01-01 00:00:00+00'::timestamptz)
            ELSE date_trunc(p_granularity,f.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' END AS bin,
            CASE WHEN source_aware THEN CASE WHEN f.scheduled_task_id IS NOT NULL THEN 'scheduled' ELSE t.surface END END AS usage_surface,
            opengeni_insights_internal.insights_usage_hourly_value(f) v
          FROM %1$I.model_call_facts f LEFT JOIN %1$I.session_turns t
            ON source_aware AND t.workspace_id=f.workspace_id AND t.id=f.turn_id$new$),
      (1, $old$(fv.v).scheduled_task_id,
            max$old$, $new$(fv.v).scheduled_task_id,fv.usage_surface,
            max$new$),
      (1, $old$(fv.v).scheduled_task_id
        ) SELECT$old$, $new$(fv.v).scheduled_task_id,fv.usage_surface
        ) SELECT$new$),
      (1, $old$'scheduled_task_id','recorded_at'])
            ||jsonb_build_object('chargedMicros',0)$old$, $new$'scheduled_task_id','recorded_at','usage_surface'])
            ||jsonb_build_object('chargedMicros',0)
            ||CASE WHEN source_aware THEN jsonb_build_object('usageSurface',r.usage_surface) ELSE '{}'::jsonb END$new$),
      (1, $old$'listCacheWrite',0,'listOutput',0),true$old$, $new$'listCacheWrite',0,'listOutput',0)
          ||CASE WHEN source_aware THEN jsonb_build_object('usageSurface',
            CASE WHEN f.scheduled_task_id IS NOT NULL THEN 'scheduled' ELSE t.surface END) ELSE '{}'::jsonb END,true$new$),
      (1, $old$AND f.source_key=substr(c.source_id,38)
      WHERE$old$, $new$AND f.source_key=substr(c.source_id,38)
      LEFT JOIN %1$I.session_turns t ON source_aware AND t.workspace_id=f.workspace_id AND t.id=f.turn_id
      WHERE$new$),
      (2, $old$detail_allowed boolean;inventory uuid;
    BEGIN$old$, $new$detail_allowed boolean;inventory uuid;source_aware boolean := right(p_granularity, 7) = ':source';
    BEGIN
      IF source_aware THEN p_granularity := left(p_granularity, -7); END IF;$new$),
      (2, $old$insights_usage_amount_inputs(a,w.id,p_since,p_until,p_granularity) f$old$, $new$insights_usage_amount_inputs(a,w.id,p_since,p_until,
                CASE WHEN source_aware THEN p_granularity||':source' ELSE p_granularity END) f$new$),
      (2, $old$END,'m',f.m) AS p$old$, $new$END,'m',f.m-'usageSurface')
                || CASE WHEN source_aware AND f.kind='item' THEN jsonb_build_object('usageSurface',f.m->>'usageSurface') ELSE '{}'::jsonb END AS p$new$),
      (3, $old$AND opengeni_private.insights_usage_filter(meta,p_query)$old$, $new$AND opengeni_private.insights_usage_filter(meta,p_query)
            AND (NOT p_query?'source' OR coalesce(p_query->'usageSourceSurfaces'->>(
              CASE WHEN f.scheduled_task_id IS NOT NULL THEN 'scheduled' ELSE (
                SELECT t.surface FROM %1$I.session_turns t WHERE t.workspace_id=f.workspace_id AND t.id=f.turn_id
              ) END), 'other') IN(SELECT jsonb_array_elements_text(p_query->'source')))$new$)
    ) AS edits(target, anchor, replacement)
    WHERE target=CASE routine::oid
      WHEN 'opengeni_insights_internal.insights_usage_amount_inputs(uuid,uuid,timestamptz,timestamptz,text)'::regprocedure::oid THEN 1
      WHEN 'opengeni_private.insights_scoped_usage_rows(uuid,uuid,timestamptz,timestamptz,text,uuid[],boolean)'::regprocedure::oid THEN 2
      ELSE 3 END LOOP
      IF length(definition)-length(replace(definition, format(edit.anchor,data_schema),''))<>length(format(edit.anchor,data_schema)) THEN
        RAISE EXCEPTION 'Insights usage source: % changed near %',routine,edit.anchor;
      END IF;
      definition := replace(definition,format(edit.anchor,data_schema),format(edit.replacement,data_schema));
    END LOOP;
    EXECUTE definition;
  END LOOP;
END
$install$;
