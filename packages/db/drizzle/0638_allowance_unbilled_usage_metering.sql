-- deployment-mode: rolling
-- Usage allowances can opt into counting model calls that spend no Opengeni
-- credits (subscription connections, workspace keys, deployments without
-- credit billing) at their configured list-price estimate. The default
-- (`unbilledUsage` absent or "ignore") keeps allowances credit-ledger-only.
--
-- Credit-ledger debits remain counted by count_workspace_allowance_debit().
-- A model call fact with priced_cost_micros > 0 always has a matching ledger
-- debit, so this trigger only counts facts with priced_cost_micros = 0 and
-- never double-counts one call.

CREATE OR REPLACE FUNCTION validate_usage_allowance_config(p_config jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path FROM CURRENT AS $$
DECLARE thresholds jsonb; threshold_item jsonb; default_rule jsonb;
BEGIN
  IF p_config IS NULL OR jsonb_typeof(p_config)<>'object' OR octet_length(p_config::text)>8192
    OR jsonb_typeof(p_config->'includedCredits') IS DISTINCT FROM 'number'
    OR coalesce(p_config->>'period','') NOT IN ('monthly','none') THEN RETURN false; END IF;
  IF NOT validate_usage_allowance_rule(jsonb_build_object('credits',p_config->'includedCredits')) THEN RETURN false; END IF;
  IF p_config ? 'anchorDay' AND (jsonb_typeof(p_config->'anchorDay')<>'number'
    OR (p_config->>'anchorDay')::numeric NOT BETWEEN 1 AND 31
    OR trunc((p_config->>'anchorDay')::numeric)<>(p_config->>'anchorDay')::numeric) THEN RETURN false; END IF;
  IF p_config ? 'unbilledUsage' AND (jsonb_typeof(p_config->'unbilledUsage') IS DISTINCT FROM 'string'
    OR p_config->>'unbilledUsage' NOT IN ('ignore','list_price')) THEN RETURN false; END IF;
  default_rule:=p_config->'memberDefault';
  IF default_rule IS NOT NULL AND default_rule NOT IN ('"none"'::jsonb,'"equal_share"'::jsonb)
    AND (default_rule='null'::jsonb OR NOT validate_usage_allowance_rule(default_rule)) THEN RETURN false; END IF;
  IF p_config ? 'thresholds' THEN
    IF jsonb_typeof(p_config->'thresholds')<>'object' THEN RETURN false; END IF;
    FOR thresholds IN SELECT item.value FROM jsonb_each(p_config->'thresholds') item LOOP
      IF jsonb_typeof(thresholds)<>'array' OR jsonb_array_length(thresholds)>16 THEN RETURN false; END IF;
      FOR threshold_item IN SELECT jsonb_array_elements(thresholds) LOOP
        IF jsonb_typeof(threshold_item)<>'number' OR (threshold_item#>>'{}')::numeric<=0 OR (threshold_item#>>'{}')::numeric>1 THEN RETURN false; END IF;
      END LOOP;
    END LOOP;
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION count_unbilled_model_allowance_debit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  cfg jsonb; p record; c opengeni_private.workspace_allowance_counters%ROWTYPE; g record;
  saved opengeni_private.workspace_usage_allowances%ROWTYPE;
  human text; amount bigint;
  included bigint := 0; grant_used bigint := 0; pending bigint;
  opened integer;
BEGIN
  IF NEW.workspace_id IS NULL OR NEW.priced_cost_micros <> 0
    OR coalesce(NEW.estimated_provider_cost_micros,0) <= 0 THEN RETURN NULL; END IF;
  -- A late cost fill-in counts once; an unchanged or already-priced row never recounts.
  IF TG_OP='UPDATE' AND OLD.estimated_provider_cost_micros IS NOT NULL THEN RETURN NULL; END IF;
  amount := NEW.estimated_provider_cost_micros;
  PERFORM 1 FROM workspaces WHERE id=NEW.workspace_id AND account_id=NEW.account_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'allowance debit workspace mismatch' USING ERRCODE='23503'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('usage-allowance:' || NEW.workspace_id::text,0));
  INSERT INTO opengeni_private.usage_allowance_capabilities VALUES
    (pg_backend_pid(),pg_current_xact_id(),TG_TABLE_SCHEMA,NEW.account_id,NEW.workspace_id)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS opened = ROW_COUNT;
  SELECT * INTO saved FROM opengeni_private.workspace_usage_allowances WHERE workspace_id=NEW.workspace_id;
  cfg:=saved.config;
  IF cfg IS NOT NULL AND cfg->>'unbilledUsage'='list_price' THEN
    SELECT * INTO p FROM usage_allowance_effective_period(NEW.workspace_id,cfg,clock_timestamp());
    IF saved.active_period_key IS DISTINCT FROM p.period_key THEN
      UPDATE opengeni_private.workspace_allowance_periods
        SET closed_at=coalesce(saved.active_end_at,clock_timestamp())
        WHERE workspace_id=NEW.workspace_id AND period_key=saved.active_period_key AND closed_at IS NULL;
    END IF;
    UPDATE opengeni_private.workspace_usage_allowances SET active_period_key=p.period_key,
      active_start_at=p.start_at,active_end_at=p.end_at WHERE workspace_id=NEW.workspace_id;
    SELECT * INTO c FROM opengeni_private.workspace_allowance_counters
      WHERE workspace_id=NEW.workspace_id AND period_key=p.period_key AND subject_id='';
    included := least(amount,greatest(0,(cfg->>'includedCredits')::bigint-
      (coalesce(c.used,0)-coalesce(c.grants_used,0))));
    pending := amount-included;
    FOR g IN SELECT * FROM opengeni_private.workspace_allowance_grants WHERE workspace_id=NEW.workspace_id
      AND remaining>0 AND (expires_at IS NULL OR expires_at>clock_timestamp())
      ORDER BY expires_at NULLS LAST,created_at,operation_id
    LOOP
      EXIT WHEN pending=0;
      UPDATE opengeni_private.workspace_allowance_grants SET remaining=remaining-least(pending,g.remaining)
        WHERE workspace_id=NEW.workspace_id AND operation_id=g.operation_id;
      grant_used := grant_used+least(pending,g.remaining);
      pending := pending-least(pending,g.remaining);
    END LOOP;
    INSERT INTO opengeni_private.workspace_allowance_counters (workspace_id,account_id,period_key,subject_id,used,included_used,grants_used)
      VALUES (NEW.workspace_id,NEW.account_id,p.period_key,'',amount,included,grant_used)
    ON CONFLICT (workspace_id,period_key,subject_id) DO UPDATE SET
      used=opengeni_private.workspace_allowance_counters.used+excluded.used,
      included_used=opengeni_private.workspace_allowance_counters.included_used+excluded.included_used,
      grants_used=opengeni_private.workspace_allowance_counters.grants_used+excluded.grants_used;
    -- The turn's frozen attribution receipt names the causal human, exactly
    -- like a credit debit for the same turn.
    SELECT receipt.attribution->>'initiatingHumanSubjectId' INTO human
    FROM opengeni_private.usage_allowance_attribution_receipts receipt
      WHERE receipt.source_kind='turn' AND receipt.source_id=NEW.turn_id::text
        AND receipt.workspace_id=NEW.workspace_id AND receipt.account_id=NEW.account_id;
    IF human IS NOT NULL THEN
      INSERT INTO opengeni_private.workspace_allowance_counters (workspace_id,account_id,period_key,subject_id,used)
        VALUES (NEW.workspace_id,NEW.account_id,p.period_key,human,amount)
      ON CONFLICT (workspace_id,period_key,subject_id) DO UPDATE SET used=opengeni_private.workspace_allowance_counters.used+excluded.used;
    END IF;
    PERFORM capture_usage_allowance_period(NEW.account_id,NEW.workspace_id,cfg,clock_timestamp());
    UPDATE opengeni_private.workspace_usage_allowances SET maintenance_next_at=least(maintenance_next_at,clock_timestamp())
      WHERE workspace_id=NEW.workspace_id;
  END IF;
  IF opened=1 THEN
    DELETE FROM opengeni_private.usage_allowance_capabilities WHERE backend_pid=pg_backend_pid()
      AND transaction_id=pg_current_xact_id_if_assigned() AND data_schema=TG_TABLE_SCHEMA AND workspace_id=NEW.workspace_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER model_call_unbilled_allowance_debit AFTER INSERT ON model_call_facts
FOR EACH ROW WHEN (NEW.priced_cost_micros = 0 AND NEW.estimated_provider_cost_micros > 0)
EXECUTE FUNCTION count_unbilled_model_allowance_debit();
CREATE TRIGGER model_call_unbilled_allowance_cost_fill AFTER UPDATE OF estimated_provider_cost_micros ON model_call_facts
FOR EACH ROW WHEN (OLD.estimated_provider_cost_micros IS NULL AND NEW.priced_cost_micros = 0
  AND NEW.estimated_provider_cost_micros > 0)
EXECUTE FUNCTION count_unbilled_model_allowance_debit();

REVOKE ALL ON FUNCTION validate_usage_allowance_config(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION count_unbilled_model_allowance_debit() FROM PUBLIC;
-- CREATE OR REPLACE resets SET clauses: pin the search path after the final
-- replacement and strip any inherited grants from both owner-internal routines.
DO $acl$
DECLARE role_name text; function_name text; target_schema text := current_schema();
BEGIN
  FOREACH function_name IN ARRAY ARRAY['validate_usage_allowance_config(jsonb)',
    'count_unbilled_model_allowance_debit()']
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path=pg_catalog,%I,pg_temp',target_schema,function_name,target_schema);
    FOR role_name IN SELECT DISTINCT r.rolname FROM pg_proc p,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      JOIN pg_roles r ON r.oid=acl.grantee
      WHERE p.oid=format('%I.%s',target_schema,function_name)::regprocedure AND acl.grantee<>p.proowner
    LOOP EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM %I',target_schema,function_name,role_name); END LOOP;
  END LOOP;
END $acl$;