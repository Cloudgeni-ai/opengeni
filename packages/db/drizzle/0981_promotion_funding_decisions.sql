-- deployment-mode: rolling
-- Additive state, inert until the operator enables promotion_enforcement AFTER
-- every API/control/turn reader runs this release. Older readers ignore holds.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE promotion_decisions (
  account_id uuid PRIMARY KEY,
  decision text NOT NULL CHECK (decision IN ('eligible','verification_required','held','denied')),
  revision bigint NOT NULL CHECK (revision > 0),
  actor text NOT NULL CHECK (octet_length(actor) BETWEEN 1 AND 200),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS opengeni_private.promotion_decision_history (
  data_schema text NOT NULL, account_id uuid NOT NULL, revision bigint NOT NULL,
  decision text NOT NULL, actor text NOT NULL, updated_at timestamptz NOT NULL,
  policy_version text NOT NULL CHECK (octet_length(policy_version) BETWEEN 1 AND 120),
  rule_id text NOT NULL CHECK (octet_length(rule_id) BETWEEN 1 AND 120),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 8192),
  PRIMARY KEY(data_schema,account_id,revision)
);
CREATE TABLE promotion_enforcement (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false
);
INSERT INTO promotion_enforcement(singleton) VALUES(true);
ALTER TABLE promotion_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotion_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE promotion_enforcement ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotion_enforcement FORCE ROW LEVEL SECURITY;
CREATE POLICY promotion_tenant_read ON promotion_decisions FOR SELECT
  USING (account_id=opengeni_private.current_account_id());
CREATE POLICY promotion_enforcement_read ON promotion_enforcement FOR SELECT USING(true);
DO $owner_policy$
BEGIN
  EXECUTE format('CREATE POLICY promotion_owner ON promotion_decisions TO %I USING(true) WITH CHECK(true)', current_user);
  EXECUTE format('CREATE POLICY promotion_owner ON promotion_enforcement TO %I USING(true) WITH CHECK(true)', current_user);
END $owner_policy$;
REVOKE ALL ON promotion_decisions,promotion_enforcement,opengeni_private.promotion_decision_history FROM PUBLIC;

-- Owner-only mutation. Credit advisory lock is shared with grant and debit
-- writers; this function takes no workspace or organization row locks.
CREATE OR REPLACE FUNCTION opengeni_private.set_promotion_decision(
  p_account_id uuid, p_decision text, p_policy_version text, p_rule_id text,
  p_evidence jsonb, p_actor text, p_expected_revision bigint DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE prior promotion_decisions%ROWTYPE;
  result promotion_decisions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_account_id::text));
  SELECT * INTO prior FROM promotion_decisions WHERE account_id=p_account_id;
  IF p_expected_revision IS NOT NULL AND p_expected_revision <> coalesce(prior.revision,0) THEN
    RAISE EXCEPTION 'Promotion decision changed' USING ERRCODE='40001';
  END IF;
  INSERT INTO promotion_decisions
    (account_id, decision, revision, actor)
  VALUES (p_account_id,p_decision,coalesce(prior.revision,0)+1,p_actor)
  ON CONFLICT (account_id) DO UPDATE SET decision=excluded.decision, revision=excluded.revision,
    actor=excluded.actor,updated_at=clock_timestamp()
  RETURNING * INTO result;
  INSERT INTO opengeni_private.promotion_decision_history
    (data_schema,account_id,revision,decision,actor,updated_at,policy_version,rule_id,evidence)
  VALUES (session_tenancy_fence_target_schema()::regnamespace::text,result.account_id,result.revision,result.decision,
    result.actor,result.updated_at,p_policy_version,p_rule_id,p_evidence);
  RETURN to_jsonb(result);
END $$;
REVOKE ALL ON FUNCTION opengeni_private.set_promotion_decision(uuid,text,text,text,jsonb,text,bigint) FROM PUBLIC;

DO $pin$
DECLARE r regprocedure;
BEGIN
  FOR r IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='opengeni_private' AND p.proname IN ('set_promotion_decision')
  LOOP EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, opengeni_private, pg_temp',r,current_schema()); END LOOP;
END $pin$;

CREATE OR REPLACE FUNCTION free_plan_credit_eligible(p_account_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Plan account scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM promotion_enforcement WHERE enabled) AND EXISTS
    (SELECT 1 FROM promotion_decisions WHERE account_id=p_account_id AND decision <> 'eligible') THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM credit_ledger_entries WHERE account_id = p_account_id
    AND type = 'grant' AND source_type = 'verified_signup_trial'
    AND idempotency_key = 'verified-signup-trial:v1:' || source_id AND amount_micros >= 0);
END $body$;


DO $install$
DECLARE data_schema text := current_schema(); routine regprocedure;
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.list_subscription_plan_maintenance_accounts(p_limit integer)
    RETURNS TABLE (account_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
    DECLARE inventory_id uuid; sweep_time timestamptz := clock_timestamp();
    BEGIN
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION 'Invalid subscription plan maintenance bound' USING ERRCODE = '22023';
      END IF;
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      RETURN QUERY
        SELECT candidate.account_id FROM (
          (SELECT period.account_id FROM %1$I.plan_credit_periods period
            WHERE period.expired_at IS NULL AND period.period_end <= sweep_time
            ORDER BY period.period_end, period.account_id LIMIT p_limit)
          UNION
          (SELECT account.id AS account_id FROM %1$I.managed_accounts account
            LEFT JOIN %1$I.organization_plans state ON state.account_id = account.id
            CROSS JOIN LATERAL opengeni_private.subscription_plan_free_anniversary(account.created_at, greatest(account.created_at, sweep_time)) anniversary
            WHERE account.created_at <= sweep_time
              AND (state.account_id IS NULL
                OR (state.plan_key IN ('pro', 'max') AND state.status IN ('canceled', 'unpaid', 'incomplete_expired') AND state.current_period_end <= sweep_time)
                OR (state.plan_key = 'free' AND state.status IN ('active', 'trialing') AND state.stripe_subscription_id IS NULL
                  AND (opengeni_private.subscription_plan_definition('free')->>'freeCredit')::boolean
                  AND NOT EXISTS (SELECT 1 FROM %1$I.promotion_decisions hold
                    WHERE hold.account_id=account.id AND hold.decision <> 'eligible'
                    AND EXISTS (SELECT 1 FROM %1$I.promotion_enforcement WHERE enabled))
                  AND EXISTS (SELECT 1 FROM %1$I.credit_ledger_entries trial
                    WHERE trial.account_id = account.id AND trial.type = 'grant' AND trial.source_type = 'verified_signup_trial'
                      AND trial.idempotency_key = 'verified-signup-trial:v1:' || trial.source_id AND trial.amount_micros >= 0)
                  AND NOT EXISTS (SELECT 1 FROM %1$I.plan_credit_periods receipt
                    WHERE receipt.account_id = account.id
                      AND receipt.idempotency_key = 'plan-credit:free:' || account.id::text || ':' || to_char(anniversary.period_start AT TIME ZONE 'UTC', 'YYYY-MM'))))
              AND NOT EXISTS (SELECT 1 FROM %1$I.plan_credit_periods live
                WHERE live.account_id = account.id AND live.expired_at IS NULL AND live.period_end > sweep_time)
            ORDER BY account.id LIMIT p_limit)
        ) candidate ORDER BY candidate.account_id LIMIT p_limit;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END $body$;
  $create$, data_schema);
  -- CREATE OR REPLACE keeps owner/ACLs. Restore the pinned definer search paths.
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname = data_schema AND p.proname = 'free_plan_credit_eligible')
      OR (n.nspname = 'opengeni_private' AND p.proname = 'grant_verified_signup_trial_credit')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, opengeni_private, pg_temp', routine, data_schema);
  END LOOP;
END $install$;

DO $grants$
DECLARE role_name text;
BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname='opengeni_app'
    OR rolname IN (SELECT jsonb_array_elements_text(coalesce(nullif(current_setting('opengeni.migration_application_roles',true),''),'[]')::jsonb))
  LOOP
    EXECUTE format('REVOKE ALL ON promotion_decisions,promotion_enforcement FROM %I',role_name);
    EXECUTE format('GRANT SELECT ON promotion_decisions,promotion_enforcement TO %I',role_name);
  END LOOP;
END $grants$;

CREATE TABLE IF NOT EXISTS opengeni_private.promotion_enforcement_events (
  data_schema text NOT NULL, revision bigint NOT NULL, enabled boolean NOT NULL,
  operator text NOT NULL CHECK(octet_length(operator) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK(octet_length(reason) BETWEEN 6 AND 1000),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(data_schema,revision)
);
REVOKE ALL ON opengeni_private.promotion_enforcement_events FROM PUBLIC;
CREATE OR REPLACE FUNCTION opengeni_private.set_promotion_enforcement(
  p_enabled boolean,p_operator text,p_reason text,p_all_readers_upgraded boolean DEFAULT false
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE next_revision bigint; target text := session_tenancy_fence_target_schema()::regnamespace::text;
BEGIN
  IF p_enabled AND p_all_readers_upgraded IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Promotion enforcement requires all API/control/turn readers upgraded' USING ERRCODE='55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('promotion-enforcement:' || target,0));
  SELECT coalesce(max(revision),0)+1 INTO next_revision FROM opengeni_private.promotion_enforcement_events WHERE data_schema=target;
  UPDATE promotion_enforcement SET enabled=p_enabled WHERE singleton;
  INSERT INTO opengeni_private.promotion_enforcement_events(data_schema,revision,enabled,operator,reason)
    VALUES(target,next_revision,p_enabled,p_operator,p_reason);
  RETURN next_revision;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.set_promotion_enforcement(boolean,text,text,boolean) FROM PUBLIC;
DO $pin_enforcement$ BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.set_promotion_enforcement(boolean,text,text,boolean) SET search_path = pg_catalog,%I,opengeni_private,pg_temp',current_schema());
END $pin_enforcement$;
