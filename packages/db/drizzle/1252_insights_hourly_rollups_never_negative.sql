-- deployment-mode: rolling
-- An Insights hourly rollup group must never hold a negative amount.
--
-- insights_usage_hourly_delta subtracted a deleted model call fact with an
-- upsert. When the group's rollup row was missing (for example a manual
-- cleanup removed rollup rows before the facts they summarize) the INSERT
-- branch stored the negated amounts as a new row. Every Insights usage read
-- that covered the hour then failed, because readers reject negative
-- quantities instead of reporting wrong totals.
--
-- A subtraction now updates the group only when every measure stays
-- non-negative. Otherwise it records the group in
-- insights_usage_hourly_repairs, and a deferred constraint trigger rebuilds
-- that one group from model_call_facts at commit, after every row trigger of
-- the transaction has run. Rebuilding at commit rather than in the row trigger
-- matters: row triggers fire after the whole statement, so a mid-statement
-- rebuild would already exclude later rows of the same statement and their
-- own subtractions would then be applied twice.
--
-- Finally, every hour that already holds a negative rollup row is rebuilt from
-- its facts with the existing hourly recompute. That touches only those hours
-- and is idempotent.
--
-- The previous release keeps working: signatures, owners and grants are
-- unchanged, and the new table and routines are owner-only.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Rows live only inside the transaction that queued them; the deferred
-- trigger deletes each one after rebuilding its group. The transaction id
-- keeps concurrent transactions from waiting on each other's queued rows.
CREATE TABLE opengeni_private.insights_usage_hourly_repairs (
    transaction_id xid8 NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    hour timestamp with time zone NOT NULL,
    session_id uuid,
    provider text NOT NULL,
    model text NOT NULL,
    payer text NOT NULL,
    scheduled_task_id uuid,
    CONSTRAINT insights_usage_hourly_repairs_key UNIQUE NULLS NOT DISTINCT
      (transaction_id, account_id, workspace_id, hour, session_id, provider, model, payer, scheduled_task_id)
);

REVOKE ALL ON TABLE opengeni_private.insights_usage_hourly_repairs FROM PUBLIC;

-- Later migrations name the install schema at run time; the baseline wrote it
-- as a placeholder.
DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
CREATE FUNCTION opengeni_insights_internal.insights_usage_hourly_recompute_group(a uuid, w uuid, h timestamp with time zone, s uuid, p text, m text, pay text, t uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
    AS $$
    DECLARE fresh opengeni_private.insights_usage_hourly_rollups;
    BEGIN
      IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='%1$s.model_call_facts'::regclass)) THEN
        RAISE EXCEPTION 'Insights hourly group recompute is owner-invoked only' USING ERRCODE='42501'; END IF;
      -- Same FK-writer prefix as the hourly recompute. A deleted workspace has
      -- no rollups to repair.
      PERFORM 1 FROM %1$I.workspaces WHERE account_id=a AND id=w FOR KEY SHARE;
      IF NOT FOUND THEN RETURN; END IF;
      PERFORM pg_advisory_xact_lock_shared(opengeni_insights_internal.insights_usage_hour_lock(w,h));
      -- Hold the group row like a fact delta does. A concurrent delta either
      -- commits first (and the snapshot below includes its fact) or waits and
      -- then applies its amounts on top of the rebuilt row.
      INSERT INTO opengeni_private.insights_usage_hourly_rollups
        VALUES(a,w,h,s,p,m,pay,t,NULL,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0)
        ON CONFLICT(account_id,workspace_id,hour,session_id,provider,model,payer,scheduled_task_id) DO NOTHING;
      PERFORM 1 FROM opengeni_private.insights_usage_hourly_rollups r WHERE r.account_id=a AND r.workspace_id=w AND r.hour=h
        AND r.session_id IS NOT DISTINCT FROM s AND r.provider=p AND r.model=m AND r.payer=pay
        AND r.scheduled_task_id IS NOT DISTINCT FROM t FOR UPDATE;
      -- A new statement, so READ COMMITTED reads facts after the lock.
      SELECT x.* INTO fresh FROM opengeni_insights_internal.insights_usage_hourly_raw(a,w,h,h+interval '1 hour') x
        WHERE x.session_id IS NOT DISTINCT FROM s AND x.provider=p AND x.model=m AND x.payer=pay
          AND x.scheduled_task_id IS NOT DISTINCT FROM t;
      IF NOT FOUND THEN
        DELETE FROM opengeni_private.insights_usage_hourly_rollups r WHERE r.account_id=a AND r.workspace_id=w AND r.hour=h
          AND r.session_id IS NOT DISTINCT FROM s AND r.provider=p AND r.model=m AND r.payer=pay
          AND r.scheduled_task_id IS NOT DISTINCT FROM t;
        RETURN;
      END IF;
      UPDATE opengeni_private.insights_usage_hourly_rollups r SET recorded_at=fresh.recorded_at,
        calls=fresh.calls,"tokenKnownCalls"=fresh."tokenKnownCalls","cacheKnownCalls"=fresh."cacheKnownCalls",
        "cacheWriteKnownCalls"=fresh."cacheWriteKnownCalls","listClassKnownCalls"=fresh."listClassKnownCalls",
        "uncachedInput"=fresh."uncachedInput","cacheRead"=fresh."cacheRead","cacheWrite"=fresh."cacheWrite",
        output=fresh.output,reasoning=fresh.reasoning,"listMicros"=fresh."listMicros","pricedCalls"=fresh."pricedCalls",
        "listApproxCalls"=fresh."listApproxCalls","listUncachedInput"=fresh."listUncachedInput",
        "listCacheRead"=fresh."listCacheRead","listCacheWrite"=fresh."listCacheWrite","listOutput"=fresh."listOutput"
      WHERE r.account_id=a AND r.workspace_id=w AND r.hour=h
        AND r.session_id IS NOT DISTINCT FROM s AND r.provider=p AND r.model=m AND r.payer=pay
        AND r.scheduled_task_id IS NOT DISTINCT FROM t;
    END
    $$;

CREATE FUNCTION opengeni_insights_internal.insights_usage_hourly_repair() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
    AS $$
    BEGIN
      PERFORM opengeni_insights_internal.insights_usage_hourly_recompute_group(NEW.account_id,NEW.workspace_id,NEW.hour,
        NEW.session_id,NEW.provider,NEW.model,NEW.payer,NEW.scheduled_task_id);
      DELETE FROM opengeni_private.insights_usage_hourly_repairs q WHERE q.transaction_id=NEW.transaction_id
        AND q.account_id=NEW.account_id AND q.workspace_id=NEW.workspace_id AND q.hour=NEW.hour
        AND q.session_id IS NOT DISTINCT FROM NEW.session_id AND q.provider=NEW.provider AND q.model=NEW.model
        AND q.payer=NEW.payer AND q.scheduled_task_id IS NOT DISTINCT FROM NEW.scheduled_task_id;
      RETURN NULL;
    END
    $$;

CREATE OR REPLACE FUNCTION opengeni_insights_internal.insights_usage_hourly_delta(v opengeni_private.insights_usage_hourly_rollups, d bigint) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
    AS $$
    DECLARE latest timestamptz; remaining bigint; empty boolean;
    BEGIN
      IF d>0 THEN
        INSERT INTO opengeni_private.insights_usage_hourly_rollups AS r
        SELECT v.account_id,v.workspace_id,v.hour,v.session_id,v.provider,v.model,v.payer,v.scheduled_task_id,v.recorded_at,
          v.calls,v."tokenKnownCalls",v."cacheKnownCalls",v."cacheWriteKnownCalls",v."listClassKnownCalls",
          v."uncachedInput",v."cacheRead",v."cacheWrite",v.output,v.reasoning,v."listMicros",v."pricedCalls",
          v."listApproxCalls",v."listUncachedInput",v."listCacheRead",v."listCacheWrite",v."listOutput"
        ON CONFLICT(account_id,workspace_id,hour,session_id,provider,model,payer,scheduled_task_id) DO UPDATE SET
          recorded_at=greatest(r.recorded_at,excluded.recorded_at),
          calls=r.calls+excluded.calls,"tokenKnownCalls"=r."tokenKnownCalls"+excluded."tokenKnownCalls",
          "cacheKnownCalls"=r."cacheKnownCalls"+excluded."cacheKnownCalls",
          "cacheWriteKnownCalls"=r."cacheWriteKnownCalls"+excluded."cacheWriteKnownCalls",
          "listClassKnownCalls"=r."listClassKnownCalls"+excluded."listClassKnownCalls",
          "uncachedInput"=r."uncachedInput"+excluded."uncachedInput","cacheRead"=r."cacheRead"+excluded."cacheRead",
          "cacheWrite"=r."cacheWrite"+excluded."cacheWrite",output=r.output+excluded.output,reasoning=r.reasoning+excluded.reasoning,
          "listMicros"=r."listMicros"+excluded."listMicros","pricedCalls"=r."pricedCalls"+excluded."pricedCalls",
          "listApproxCalls"=r."listApproxCalls"+excluded."listApproxCalls",
          "listUncachedInput"=r."listUncachedInput"+excluded."listUncachedInput","listCacheRead"=r."listCacheRead"+excluded."listCacheRead",
          "listCacheWrite"=r."listCacheWrite"+excluded."listCacheWrite","listOutput"=r."listOutput"+excluded."listOutput";
        RETURN;
      END IF;
      -- A workspace cascade has already removed its parent; do not resurrect
      -- a rollup through the fact table's own cascading deletes.
      IF NOT EXISTS(SELECT 1 FROM %1$I.workspaces WHERE id=v.workspace_id) THEN RETURN; END IF;
      -- Subtract only amounts the group holds. A missing or smaller group means
      -- the rollup no longer matches its facts: never store the difference as a
      -- negative row, rebuild the group from its facts at commit instead.
      UPDATE opengeni_private.insights_usage_hourly_rollups r SET
        calls=r.calls-v.calls,"tokenKnownCalls"=r."tokenKnownCalls"-v."tokenKnownCalls",
        "cacheKnownCalls"=r."cacheKnownCalls"-v."cacheKnownCalls",
        "cacheWriteKnownCalls"=r."cacheWriteKnownCalls"-v."cacheWriteKnownCalls",
        "listClassKnownCalls"=r."listClassKnownCalls"-v."listClassKnownCalls",
        "uncachedInput"=r."uncachedInput"-v."uncachedInput","cacheRead"=r."cacheRead"-v."cacheRead",
        "cacheWrite"=r."cacheWrite"-v."cacheWrite",output=r.output-v.output,reasoning=r.reasoning-v.reasoning,
        "listMicros"=r."listMicros"-v."listMicros","pricedCalls"=r."pricedCalls"-v."pricedCalls",
        "listApproxCalls"=r."listApproxCalls"-v."listApproxCalls",
        "listUncachedInput"=r."listUncachedInput"-v."listUncachedInput","listCacheRead"=r."listCacheRead"-v."listCacheRead",
        "listCacheWrite"=r."listCacheWrite"-v."listCacheWrite","listOutput"=r."listOutput"-v."listOutput"
      WHERE r.account_id=v.account_id AND r.workspace_id=v.workspace_id AND r.hour=v.hour
        AND r.session_id IS NOT DISTINCT FROM v.session_id AND r.provider=v.provider AND r.model=v.model
        AND r.payer=v.payer AND r.scheduled_task_id IS NOT DISTINCT FROM v.scheduled_task_id
        AND r.calls>=v.calls AND r."tokenKnownCalls">=v."tokenKnownCalls" AND r."cacheKnownCalls">=v."cacheKnownCalls"
        AND r."cacheWriteKnownCalls">=v."cacheWriteKnownCalls" AND r."listClassKnownCalls">=v."listClassKnownCalls"
        AND r."uncachedInput">=v."uncachedInput" AND r."cacheRead">=v."cacheRead" AND r."cacheWrite">=v."cacheWrite"
        AND r.output>=v.output AND r.reasoning>=v.reasoning AND r."listMicros">=v."listMicros"
        AND r."pricedCalls">=v."pricedCalls" AND r."listApproxCalls">=v."listApproxCalls"
        AND r."listUncachedInput">=v."listUncachedInput" AND r."listCacheRead">=v."listCacheRead"
        AND r."listCacheWrite">=v."listCacheWrite" AND r."listOutput">=v."listOutput"
      RETURNING r.recorded_at,r.calls,(r.calls=0 AND r."tokenKnownCalls"=0 AND r."cacheKnownCalls"=0
        AND r."cacheWriteKnownCalls"=0 AND r."listClassKnownCalls"=0 AND r."uncachedInput"=0 AND r."cacheRead"=0
        AND r."cacheWrite"=0 AND r.output=0 AND r.reasoning=0 AND r."listMicros"=0 AND r."pricedCalls"=0
        AND r."listApproxCalls"=0 AND r."listUncachedInput"=0 AND r."listCacheRead"=0 AND r."listCacheWrite"=0
        AND r."listOutput"=0)
      INTO latest,remaining,empty;
      IF NOT FOUND OR (remaining=0 AND NOT empty) THEN
        INSERT INTO opengeni_private.insights_usage_hourly_repairs
          VALUES(pg_current_xact_id(),v.account_id,v.workspace_id,v.hour,v.session_id,v.provider,v.model,v.payer,v.scheduled_task_id)
          ON CONFLICT DO NOTHING;
      ELSIF remaining=0 THEN
        DELETE FROM opengeni_private.insights_usage_hourly_rollups r WHERE r.account_id=v.account_id AND r.workspace_id=v.workspace_id
          AND r.hour=v.hour AND r.session_id IS NOT DISTINCT FROM v.session_id AND r.provider=v.provider AND r.model=v.model
          AND r.payer=v.payer AND r.scheduled_task_id IS NOT DISTINCT FROM v.scheduled_task_id;
      ELSIF latest<=v.recorded_at THEN
        -- The update holds the group row lock. A concurrent delta cannot
        -- overwrite the repaired max, including a move between groups.
        UPDATE opengeni_private.insights_usage_hourly_rollups r SET recorded_at=(
          SELECT x.recorded_at FROM opengeni_insights_internal.insights_usage_hourly_raw(v.account_id,v.workspace_id,v.hour,v.hour+interval '1 hour') x
          WHERE x.session_id IS NOT DISTINCT FROM v.session_id AND x.provider=v.provider AND x.model=v.model
            AND x.payer=v.payer AND x.scheduled_task_id IS NOT DISTINCT FROM v.scheduled_task_id
        ) WHERE r.account_id=v.account_id AND r.workspace_id=v.workspace_id AND r.hour=v.hour
          AND r.session_id IS NOT DISTINCT FROM v.session_id AND r.provider=v.provider AND r.model=v.model
          AND r.payer=v.payer AND r.scheduled_task_id IS NOT DISTINCT FROM v.scheduled_task_id;
      END IF;
    END
    $$;

-- Operator repair: rebuild every hour that holds a negative rollup row.
CREATE FUNCTION opengeni_insights_internal.insights_usage_hourly_repair_negative_hours() RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
    AS $$
    DECLARE target record; repaired integer:=0;
    BEGIN
      FOR target IN SELECT DISTINCT r.account_id,r.workspace_id,r.hour FROM opengeni_private.insights_usage_hourly_rollups r
        WHERE least(r.calls,r."tokenKnownCalls",r."cacheKnownCalls",r."cacheWriteKnownCalls",r."listClassKnownCalls",
          r."uncachedInput",r."cacheRead",r."cacheWrite",r.output,r.reasoning,r."listMicros",r."pricedCalls",
          r."listApproxCalls",r."listUncachedInput",r."listCacheRead",r."listCacheWrite",r."listOutput")<0
        ORDER BY r.workspace_id,r.hour
      LOOP
        PERFORM opengeni_insights_internal.insights_usage_hourly_recompute(target.account_id,target.workspace_id,target.hour);
        repaired:=repaired+1;
      END LOOP;
      RETURN repaired;
    END
    $$;
  $create$, data_schema);
END
$install$;

REVOKE ALL ON FUNCTION opengeni_insights_internal.insights_usage_hourly_recompute_group(a uuid, w uuid, h timestamp with time zone, s uuid, p text, m text, pay text, t uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_insights_internal.insights_usage_hourly_repair() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_insights_internal.insights_usage_hourly_repair_negative_hours() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER insights_usage_hourly_repair AFTER INSERT ON opengeni_private.insights_usage_hourly_repairs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_insights_internal.insights_usage_hourly_repair();

SELECT opengeni_insights_internal.insights_usage_hourly_repair_negative_hours();
