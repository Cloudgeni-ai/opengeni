-- deployment-mode: maintenance
-- Retain exact Site attribution on actual model debits, independently of fact
-- delivery and session retention. No repricing or changes to charged amounts.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';
ALTER TABLE credit_ledger_entries ADD COLUMN site_id uuid;

ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger_entries NO FORCE ROW LEVEL SECURITY;
DO $backfill$
DECLARE scope record;
BEGIN
  FOR scope IN SELECT DISTINCT account_id,workspace_id FROM sessions WHERE site_id IS NOT NULL LOOP
    PERFORM set_config('opengeni.account_id',scope.account_id::text,true);
    PERFORM set_config('opengeni.workspace_id',scope.workspace_id::text,true);
    UPDATE credit_ledger_entries c SET site_id=s.site_id FROM sessions s
      WHERE c.account_id=scope.account_id AND c.workspace_id=scope.workspace_id
        AND c.type='model_usage_debit' AND c.source_type='model_response'
        AND s.account_id=c.account_id AND s.workspace_id=c.workspace_id
        AND s.id::text=c.metadata->>'sessionId' AND s.site_id IS NOT NULL;
  END LOOP;
END
$backfill$;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger_entries FORCE ROW LEVEL SECURITY;

CREATE FUNCTION stamp_model_debit_site() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $body$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.site_id:=NULL;
    IF NEW.type='model_usage_debit' AND NEW.source_type='model_response' THEN
      SELECT s.site_id INTO NEW.site_id FROM sessions s
        WHERE s.account_id=NEW.account_id AND s.workspace_id=NEW.workspace_id
          AND s.id::text=NEW.metadata->>'sessionId';
    END IF;
  ELSIF NEW.site_id IS DISTINCT FROM OLD.site_id THEN
    RAISE EXCEPTION 'Model debit Site attribution is immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER model_debit_site_attribution BEFORE INSERT OR UPDATE ON credit_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION stamp_model_debit_site();
REVOKE ALL ON FUNCTION stamp_model_debit_site() FROM PUBLIC;
CREATE INDEX credit_ledger_site_occurred_idx ON credit_ledger_entries(workspace_id,site_id,occurred_at)
  WHERE site_id IS NOT NULL AND type='model_usage_debit' AND amount_micros<0;

DO $reader$
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.insights_site_usage(a uuid,w uuid,lo timestamptz,hi timestamptz,viewer text)
    RETURNS TABLE(payload jsonb) LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path=pg_catalog,%1$I,opengeni_private,pg_temp SET jit=off AS $fn$
    DECLARE actor text:=nullif(current_setting('opengeni.subject_id',true),'');
      human text:=nullif(current_setting('opengeni.initiating_human_subject_id',true),'');
    BEGIN
      IF a IS NULL OR w IS NULL OR a IS DISTINCT FROM nullif(current_setting('opengeni.account_id',true),'')::uuid
        OR w IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id',true),'')::uuid THEN
        RAISE EXCEPTION 'Site Insights requires exact tenant scope' USING ERRCODE='42501'; END IF;
      IF lo IS NULL OR hi IS NULL OR hi<lo OR hi-lo>interval '370 days' THEN
        RAISE EXCEPTION 'Invalid Site Insights window' USING ERRCODE='22023'; END IF;
      IF viewer IS NOT NULL AND viewer IS DISTINCT FROM actor AND viewer IS DISTINCT FROM human THEN
        RAISE EXCEPTION 'Site Insights viewer differs from the verified actor' USING ERRCODE='42501'; END IF;
      -- The existing owner+witness fact capability admits costs, not transcripts.
      INSERT INTO opengeni_private.insights_fact_read_runtime_capabilities
        (backend_pid,transaction_id,capability_kind,account_id,workspace_id,subject_id,initiating_human_subject_id)
        VALUES(pg_backend_pid(),pg_current_xact_id(),'model_call_facts',a,w,actor,human);
      BEGIN
        RETURN QUERY WITH amounts AS MATERIALIZED (
          SELECT f.site_id,1::bigint calls,CASE WHEN f.estimated_provider_cost_micros IS NULL THEN 0 ELSE 1 END::bigint priced,
            0::bigint charged,coalesce(f.estimated_provider_cost_micros,0) equivalent,
            CASE WHEN opengeni_private.insights_usage_payer(f.provider,f.billing_path)='subscription'
              THEN coalesce(f.estimated_provider_cost_micros,0) ELSE 0 END subscription,
            CASE WHEN opengeni_private.insights_usage_payer(f.provider,f.billing_path)='own_key'
              THEN coalesce(f.estimated_provider_cost_micros,0) ELSE 0 END own_key
          FROM %1$I.model_call_facts f WHERE f.account_id=a AND f.workspace_id=w
            AND f.site_id IS NOT NULL AND f.occurred_at>=lo AND f.occurred_at<hi
          UNION ALL
          SELECT c.site_id,0,0,-c.amount_micros,0,0,0 FROM %1$I.credit_ledger_entries c
            WHERE c.account_id=a AND c.workspace_id=w AND c.site_id IS NOT NULL
              AND c.type='model_usage_debit' AND c.source_type='model_response' AND c.amount_micros<0
              AND c.occurred_at>=lo AND c.occurred_at<hi
        ), visible AS MATERIALIZED (
          -- Match workspace-artifacts.visibleTo: its RLS is tenant-only.
          -- Private/unavailable Sites share one bucket; never leak their ids.
          SELECT site.id,site.title FROM %1$I.workspace_artifacts site
            WHERE site.account_id=a AND site.workspace_id=w
              AND (site.visibility='workspace_shared' OR site.owner_subject_id=viewer)
        ), grouped AS (
          SELECT v.id,coalesce(v.title,'Private or unavailable Sites') title,
            CASE WHEN v.id IS NULL THEN 'restricted' ELSE 'site' END kind,
            sum(calls)::bigint calls,sum(priced)::bigint priced,sum(charged)::bigint charged,
            sum(equivalent)::bigint equivalent,sum(subscription)::bigint subscription,sum(own_key)::bigint own_key
          FROM amounts x LEFT JOIN visible v ON v.id=x.site_id GROUP BY v.id,v.title
        ), ranked AS (
          SELECT *,row_number() OVER(ORDER BY charged DESC,equivalent DESC,id NULLS LAST) position FROM grouped
        ), bounded AS (
          SELECT id,title,kind,calls,priced,charged,equivalent,subscription,own_key FROM ranked WHERE position<=200
          UNION ALL SELECT NULL,'Other Sites','other',sum(calls)::bigint,sum(priced)::bigint,sum(charged)::bigint,
            sum(equivalent)::bigint,sum(subscription)::bigint,sum(own_key)::bigint FROM ranked WHERE position>200 HAVING count(*)>0
        ) SELECT jsonb_build_object('siteId',id,'title',title,'kind',kind,'calls',calls,'pricedCalls',priced,
          'chargedMicros',charged,'apiEquivalentMicros',equivalent,'subscriptionApiEquivalentMicros',subscription,
          'ownKeyApiEquivalentMicros',own_key) FROM bounded ORDER BY charged DESC,equivalent DESC,id NULLS LAST;
        DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities WHERE backend_pid=pg_backend_pid()
          AND transaction_id=pg_current_xact_id_if_assigned() AND capability_kind='model_call_facts';
      EXCEPTION WHEN OTHERS THEN
        DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities WHERE backend_pid=pg_backend_pid()
          AND transaction_id=pg_current_xact_id_if_assigned() AND capability_kind='model_call_facts';
        RAISE;
      END;
    END
    $fn$;
  $ddl$,current_schema());
  EXECUTE format('ALTER FUNCTION %I.stamp_model_debit_site() SET search_path=pg_catalog,%I,pg_temp',current_schema(),current_schema());
END
$reader$;

REVOKE ALL ON FUNCTION opengeni_private.insights_site_usage(uuid,uuid,timestamptz,timestamptz,text) FROM PUBLIC;
DO $acl$
DECLARE role_name text;
BEGIN
  FOR role_name IN SELECT r.rolname FROM jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) configured(value)
    JOIN pg_roles r ON r.rolname=configured.value
    WHERE has_table_privilege(r.rolname,format('%I.model_call_facts',current_schema()),'SELECT') LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.insights_site_usage(uuid,uuid,timestamptz,timestamptz,text) TO %I',role_name);
  END LOOP;
END
$acl$;

-- Analytical definers also run in installations whose migration owner bypasses
-- RLS. Keep the independent Site audience explicit, without changing native
-- private-session predicates or granting inventory access to Site transcripts.
-- This invoker view adds only a filter; it never confers underlying table access.
CREATE VIEW insights_audience_sessions WITH (security_invoker=true,security_barrier=true) AS
  SELECT * FROM sessions WHERE session_site_actor_visible(
    site_id,site_access_root_id,root_session_id,site_viewer_principal,site_owner_subject_id);
REVOKE ALL ON insights_audience_sessions FROM PUBLIC;

-- Existing migrations use source-anchored function replacement to preserve
-- signatures, ACLs and accounting protocols. Change only the sessions relation
-- in the complete, enumerated family of analytical readers; refuse source drift.
DO $analytical_audience$
DECLARE routine record; original text; updated text; changed int:=0;
BEGIN
  FOR routine IN SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='opengeni_private' AND p.proname IN (
      'visible_workspace_insights_model_call_facts','visible_workspace_insights_usage_events',
      'visible_workspace_insights_usage_projection','complete_workspace_insights_usage_projection',
      'visible_workspace_insights_model_fact_rows','workspace_insights_amount_fact_rows',
      'insights_scoped_usage_rows','insights_scoped_calls_rows') LOOP
    original:=pg_get_functiondef(routine.oid);
    updated:=regexp_replace(original,'\.sessions([[:space:]])','.insights_audience_sessions\1','g');
    IF updated=original THEN
      -- The short overloads delegate to their scoped sibling without a join.
      IF routine.proname NOT IN('visible_workspace_insights_model_call_facts','visible_workspace_insights_usage_events') THEN
        RAISE EXCEPTION 'Insights audience source contract changed: %',routine.proname; END IF;
      CONTINUE;
    END IF;
    IF routine.proname='insights_scoped_usage_rows' THEN
      -- A hidden Site is restricted, not a deleted conversation. This metadata
      -- existence check cannot project identifiers and keeps totals complete.
      updated:=replace(updated,'WHEN s.id IS NULL OR r.id IS NULL THEN ''deleted''',format(
        'WHEN (s.id IS NULL OR r.id IS NULL) AND EXISTS(SELECT 1 FROM %I.model_call_facts sf
          WHERE sf.account_id=a AND sf.workspace_id=w.id AND sf.session_id=f.session_id AND sf.site_id IS NOT NULL)
          THEN ''restricted'' WHEN s.id IS NULL OR r.id IS NULL THEN ''deleted''',current_schema()));
      IF position('sf.site_id IS NOT NULL' IN updated)=0 THEN RAISE EXCEPTION 'Insights classification source contract changed'; END IF;
    END IF;
    EXECUTE updated;
    changed:=changed+1;
  END LOOP;
  IF changed<>9 THEN RAISE EXCEPTION 'Expected nine scoped analytical readers, updated %',changed; END IF;
END
$analytical_audience$;
