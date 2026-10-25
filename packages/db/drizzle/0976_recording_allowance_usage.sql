-- deployment-mode: rolling
-- Meeting transcripts and live previews count toward usage allowances that
-- opt into `unbilledUsage: "list_price"`, like model calls that spend no
-- Opengeni credits. A recording's provider runs on the workspace's or the
-- organization's own key, so nothing is debited; the cost each transcript
-- version and live track already records at the provider's list price is
-- counted once against the workspace and the person it was for.
--
-- count_unbilled_allowance_usage() is the one place that adds unbilled usage
-- to the allowance counters. The model-call trigger now uses it too, with the
-- same behaviour as before. Dictations are excluded: they are paid for with
-- credits, so their ledger debit already counts.

CREATE FUNCTION count_unbilled_allowance_usage(
  p_account_id uuid, p_workspace_id uuid, p_human text, p_amount bigint, p_data_schema text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  cfg jsonb; p record; c opengeni_private.workspace_allowance_counters%ROWTYPE; g record;
  saved opengeni_private.workspace_usage_allowances%ROWTYPE;
  included bigint := 0; grant_used bigint := 0; pending bigint;
  opened integer;
BEGIN
  IF p_workspace_id IS NULL OR coalesce(p_amount,0) <= 0 THEN RETURN; END IF;
  PERFORM 1 FROM workspaces WHERE id=p_workspace_id AND account_id=p_account_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'allowance debit workspace mismatch' USING ERRCODE='23503'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('usage-allowance:' || p_workspace_id::text,0));
  INSERT INTO opengeni_private.usage_allowance_capabilities VALUES
    (pg_backend_pid(),pg_current_xact_id(),p_data_schema,p_account_id,p_workspace_id)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS opened = ROW_COUNT;
  SELECT * INTO saved FROM opengeni_private.workspace_usage_allowances WHERE workspace_id=p_workspace_id;
  cfg:=saved.config;
  IF cfg IS NOT NULL AND cfg->>'unbilledUsage'='list_price' THEN
    SELECT * INTO p FROM usage_allowance_effective_period(p_workspace_id,cfg,clock_timestamp());
    IF saved.active_period_key IS DISTINCT FROM p.period_key THEN
      UPDATE opengeni_private.workspace_allowance_periods
        SET closed_at=coalesce(saved.active_end_at,clock_timestamp())
        WHERE workspace_id=p_workspace_id AND period_key=saved.active_period_key AND closed_at IS NULL;
    END IF;
    UPDATE opengeni_private.workspace_usage_allowances SET active_period_key=p.period_key,
      active_start_at=p.start_at,active_end_at=p.end_at WHERE workspace_id=p_workspace_id;
    SELECT * INTO c FROM opengeni_private.workspace_allowance_counters
      WHERE workspace_id=p_workspace_id AND period_key=p.period_key AND subject_id='';
    included := least(p_amount,greatest(0,(cfg->>'includedCredits')::bigint-
      (coalesce(c.used,0)-coalesce(c.grants_used,0))));
    pending := p_amount-included;
    FOR g IN SELECT * FROM opengeni_private.workspace_allowance_grants WHERE workspace_id=p_workspace_id
      AND remaining>0 AND (expires_at IS NULL OR expires_at>clock_timestamp())
      ORDER BY expires_at NULLS LAST,created_at,operation_id
    LOOP
      EXIT WHEN pending=0;
      UPDATE opengeni_private.workspace_allowance_grants SET remaining=remaining-least(pending,g.remaining)
        WHERE workspace_id=p_workspace_id AND operation_id=g.operation_id;
      grant_used := grant_used+least(pending,g.remaining);
      pending := pending-least(pending,g.remaining);
    END LOOP;
    INSERT INTO opengeni_private.workspace_allowance_counters (workspace_id,account_id,period_key,subject_id,used,included_used,grants_used)
      VALUES (p_workspace_id,p_account_id,p.period_key,'',p_amount,included,grant_used)
    ON CONFLICT (workspace_id,period_key,subject_id) DO UPDATE SET
      used=opengeni_private.workspace_allowance_counters.used+excluded.used,
      included_used=opengeni_private.workspace_allowance_counters.included_used+excluded.included_used,
      grants_used=opengeni_private.workspace_allowance_counters.grants_used+excluded.grants_used;
    IF p_human IS NOT NULL THEN
      INSERT INTO opengeni_private.workspace_allowance_counters (workspace_id,account_id,period_key,subject_id,used)
        VALUES (p_workspace_id,p_account_id,p.period_key,p_human,p_amount)
      ON CONFLICT (workspace_id,period_key,subject_id) DO UPDATE SET used=opengeni_private.workspace_allowance_counters.used+excluded.used;
    END IF;
    PERFORM capture_usage_allowance_period(p_account_id,p_workspace_id,cfg,clock_timestamp());
    UPDATE opengeni_private.workspace_usage_allowances SET maintenance_next_at=least(maintenance_next_at,clock_timestamp())
      WHERE workspace_id=p_workspace_id;
  END IF;
  IF opened=1 THEN
    DELETE FROM opengeni_private.usage_allowance_capabilities WHERE backend_pid=pg_backend_pid()
      AND transaction_id=pg_current_xact_id_if_assigned() AND data_schema=p_data_schema AND workspace_id=p_workspace_id;
  END IF;
END $$;

-- Same behaviour as 0638: the turn's frozen attribution receipt names the
-- causal human, exactly like a credit debit for the same turn.
CREATE OR REPLACE FUNCTION count_unbilled_model_allowance_debit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE human text;
BEGIN
  IF NEW.workspace_id IS NULL OR NEW.priced_cost_micros <> 0
    OR coalesce(NEW.estimated_provider_cost_micros,0) <= 0 THEN RETURN NULL; END IF;
  -- A late cost fill-in counts once; an unchanged or already-priced row never recounts.
  IF TG_OP='UPDATE' AND OLD.estimated_provider_cost_micros IS NOT NULL THEN RETURN NULL; END IF;
  SELECT receipt.attribution->>'initiatingHumanSubjectId' INTO human
  FROM opengeni_private.usage_allowance_attribution_receipts receipt
    WHERE receipt.source_kind='turn' AND receipt.source_id=NEW.turn_id::text
      AND receipt.workspace_id=NEW.workspace_id AND receipt.account_id=NEW.account_id;
  PERFORM count_unbilled_allowance_usage(NEW.account_id,NEW.workspace_id,human,
    NEW.estimated_provider_cost_micros,TG_TABLE_SCHEMA);
  RETURN NULL;
END $$;

-- A transcript version counts once, when it completes, for whoever asked for it.
CREATE FUNCTION count_recording_transcript_allowance_usage()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM 1 FROM recordings r WHERE r.id=NEW.recording_id AND r.workspace_id=NEW.workspace_id
    AND r.purpose<>'dictation';
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM count_unbilled_allowance_usage(NEW.account_id,NEW.workspace_id,
    NEW.requested_by_subject_id,NEW.cost_usd_micros,TG_TABLE_SCHEMA);
  RETURN NULL;
END $$;

-- A live track's cost grows while it streams; each increase counts, for the
-- person recording.
CREATE FUNCTION count_recording_live_allowance_usage()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE owner text;
BEGIN
  SELECT r.owner_subject_id INTO owner FROM recordings r
    WHERE r.id=NEW.recording_id AND r.workspace_id=NEW.workspace_id AND r.purpose<>'dictation';
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM count_unbilled_allowance_usage(NEW.account_id,NEW.workspace_id,owner,
    NEW.live_cost_usd_micros-coalesce(OLD.live_cost_usd_micros,0),TG_TABLE_SCHEMA);
  RETURN NULL;
END $$;

CREATE TRIGGER recording_transcript_allowance_usage AFTER UPDATE OF state ON recording_transcript_versions
FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM 'complete' AND NEW.state = 'complete'
  AND NEW.cost_usd_micros > 0)
EXECUTE FUNCTION count_recording_transcript_allowance_usage();
CREATE TRIGGER recording_live_allowance_usage AFTER UPDATE OF live_cost_usd_micros ON recording_tracks
FOR EACH ROW WHEN (coalesce(NEW.live_cost_usd_micros,0) > coalesce(OLD.live_cost_usd_micros,0))
EXECUTE FUNCTION count_recording_live_allowance_usage();

-- CREATE OR REPLACE resets SET clauses: pin the search path and strip any
-- inherited grants from every owner-internal routine here.
DO $acl$
DECLARE role_name text; function_name text; target_schema text := current_schema();
BEGIN
  FOREACH function_name IN ARRAY ARRAY[
    'count_unbilled_allowance_usage(uuid,uuid,text,bigint,text)',
    'count_unbilled_model_allowance_debit()',
    'count_recording_transcript_allowance_usage()',
    'count_recording_live_allowance_usage()']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC',target_schema,function_name);
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path=pg_catalog,%I,pg_temp',target_schema,function_name,target_schema);
    FOR role_name IN SELECT DISTINCT r.rolname FROM pg_proc p,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      JOIN pg_roles r ON r.oid=acl.grantee
      WHERE p.oid=format('%I.%s',target_schema,function_name)::regprocedure AND acl.grantee<>p.proowner
    LOOP EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM %I',target_schema,function_name,role_name); END LOOP;
  END LOOP;
END $acl$;
