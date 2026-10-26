-- deployment-mode: rolling
-- Evidence is forward-only: an enrollment's submitted public key is NOT proof.
-- Only the API's verified Ed25519 renewal path records possession. Operator-only
-- mode defaults off; observations never change eligibility. No prompt inspection.
CREATE TABLE IF NOT EXISTS opengeni_private.promotion_detector_settings (
  data_schema text PRIMARY KEY,
  mode text NOT NULL DEFAULT 'off' CHECK (mode IN ('off','observe','enforce'))
);
CREATE TABLE IF NOT EXISTS opengeni_private.promotion_detector_mode_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  data_schema text NOT NULL,
  previous_mode text NOT NULL,
  mode text NOT NULL,
  actor text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON opengeni_private.promotion_detector_mode_history FROM PUBLIC;
CREATE OR REPLACE FUNCTION opengeni_private.set_promotion_detector_mode(p_mode text,p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE target text:=session_tenancy_fence_target_schema()::regnamespace::text; previous text;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('off','observe','enforce') OR p_actor IS NULL
    OR p_actor NOT LIKE 'operator:%' OR octet_length(p_actor) NOT BETWEEN 10 AND 200 THEN
    RAISE EXCEPTION 'Invalid detector mode or operator actor' USING ERRCODE='22023';
  END IF;
  SELECT mode INTO previous FROM opengeni_private.promotion_detector_settings WHERE data_schema=target FOR UPDATE;
  IF previous IS DISTINCT FROM p_mode THEN
    UPDATE opengeni_private.promotion_detector_settings SET mode=p_mode WHERE data_schema=target;
    INSERT INTO opengeni_private.promotion_detector_mode_history(data_schema,previous_mode,mode,actor)
      VALUES(target,previous,p_mode,p_actor);
  END IF;
  RETURN jsonb_build_object('mode',p_mode,'previousMode',previous);
END $$;
REVOKE ALL ON FUNCTION opengeni_private.set_promotion_detector_mode(text,text) FROM PUBLIC;

CREATE TABLE promotion_machine_proofs (
  account_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  credential_generation integer NOT NULL,
  key_hash text NOT NULL CHECK (length(key_hash)=64),
  first_proven_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, enrollment_id, credential_generation)
);
CREATE INDEX promotion_machine_proofs_key ON promotion_machine_proofs(key_hash,account_id);
ALTER TABLE promotion_machine_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotion_machine_proofs FORCE ROW LEVEL SECURITY;
CREATE POLICY promotion_proof_read ON promotion_machine_proofs FOR SELECT
  USING(account_id=opengeni_private.current_account_id());
CREATE POLICY promotion_proof_insert ON promotion_machine_proofs FOR INSERT
  WITH CHECK(account_id=opengeni_private.current_account_id());
DO $owner$ BEGIN
  EXECUTE format('CREATE POLICY promotion_proof_owner ON promotion_machine_proofs TO %I USING(true) WITH CHECK(true)',current_user);
END $owner$;
CREATE TABLE IF NOT EXISTS opengeni_private.promotion_detector_observations (
  data_schema text NOT NULL,
  account_id uuid NOT NULL,
  policy_version text NOT NULL,
  evidence jsonb NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(data_schema,account_id,policy_version)
);
REVOKE ALL ON opengeni_private.promotion_detector_settings,
  promotion_machine_proofs, opengeni_private.promotion_detector_observations FROM PUBLIC;

-- The existing plan-maintenance inventory covers accounts, grants and periods.
-- Allocation reads need the same owner-only transaction capability under FORCE RLS.
DO $allocation_inventory$
DECLARE target text:=current_schema(); owner_name text;
BEGIN
  SELECT pg_get_userbyid(relowner) INTO STRICT owner_name FROM pg_class
    WHERE oid=format('%I.credit_debit_allocations',target)::regclass;
  EXECUTE format('CREATE POLICY promotion_detector_inventory_read ON %I.credit_debit_allocations FOR SELECT USING (%I.session_tenancy_fence_owner_policy_active(current_user,%L,%s::oid,NULL,true))',
    target,target,owner_name,target::regnamespace::oid);
END $allocation_inventory$;

-- A bounded read-only cohort lookup followed by ONLY the current account's
-- credit fence. Never acquire multiple organization/credit locks in a detector.
-- Distinct verified recipients, tightly clustered organization creation and two
-- independently depleted allowances corroborate the proven shared machine.
CREATE OR REPLACE FUNCTION opengeni_private.evaluate_promotion_abuse(p_account_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  target text := session_tenancy_fence_target_schema()::regnamespace::text; detector_mode text;
  inventory uuid; key_row record; facts jsonb; candidate_count integer; proven_keys text[];
  depleted_count integer; recipients integer; cohort_ids uuid[]; decision_row record;
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Promotion detector scope mismatch' USING ERRCODE='42501';
  END IF;
  SELECT mode INTO detector_mode FROM opengeni_private.promotion_detector_settings WHERE data_schema=target;
  IF coalesce(detector_mode,'off')='off' THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM managed_accounts WHERE id=p_account_id
    AND created_at>=statement_timestamp()-interval '7 days') THEN RETURN; END IF;
  SELECT array_agg(key_hash) INTO proven_keys FROM (
    SELECT key_hash FROM promotion_machine_proofs WHERE account_id=p_account_id
      GROUP BY key_hash ORDER BY max(first_proven_at) DESC,key_hash LIMIT 17
  ) bounded;
  IF cardinality(proven_keys)>16 THEN
    INSERT INTO opengeni_private.promotion_detector_observations(data_schema,account_id,policy_version,evidence)
      VALUES(target,p_account_id,'machine-key-overflow-v1',jsonb_build_object(
        'ruleId','machine-key-overflow-v1','requiresOperatorReview',true,'provenKeyCountAtLeast',17))
      ON CONFLICT(data_schema,account_id,policy_version) DO UPDATE SET last_seen_at=clock_timestamp();
    RETURN;
  END IF;
  inventory := opengeni_private.open_session_tenancy_fence_inventory(target::regnamespace::oid);
  FOR key_row IN SELECT unnest(proven_keys) AS key_hash
  LOOP
    WITH proven AS (
      SELECT DISTINCT account_id FROM promotion_machine_proofs
      WHERE key_hash=key_row.key_hash
    ), candidates AS (
      SELECT a.id,a.created_at,receipt.source_id FROM proven p
      JOIN managed_accounts a ON a.id=p.account_id
      JOIN credit_ledger_entries receipt ON receipt.account_id=a.id
        AND receipt.source_type='verified_signup_trial' AND receipt.type='grant'
        AND receipt.idempotency_key='verified-signup-trial:v1:' || receipt.source_id
      WHERE a.created_at >= statement_timestamp()-interval '7 days'
      ORDER BY a.created_at DESC,a.id LIMIT 101
    ), cohort AS (
      SELECT * FROM candidates WHERE created_at >= (SELECT max(created_at) FROM candidates)-interval '24 hours'
    ), depleted AS (
      SELECT c.id FROM cohort c WHERE EXISTS (
        SELECT 1 FROM plan_credit_periods period JOIN credit_ledger_entries grant_row ON grant_row.id=period.grant_entry_id
        WHERE period.account_id=c.id AND period.plan_key='free' AND grant_row.amount_micros>0
          AND opengeni_private.plan_period_usage(period,statement_timestamp()) >= grant_row.amount_micros*0.9
      )
    )
    SELECT count(*)::int,count(DISTINCT source_id)::int,
      CASE WHEN (SELECT count(*) FROM candidates)>100 THEN -1 ELSE (SELECT count(*)::int FROM depleted) END,array_agg(id ORDER BY id)
      INTO candidate_count,recipients,depleted_count,cohort_ids FROM cohort;
    -- Overflow is ambiguous and needs operator review; never truncate a cohort
    -- into a seemingly exact automatic decision. Never propagate transitively.
    IF depleted_count=-1 THEN
      INSERT INTO opengeni_private.promotion_detector_observations(data_schema,account_id,policy_version,evidence)
        VALUES(target,p_account_id,'machine-cohort-overflow-v1',jsonb_build_object(
          'ruleId','machine-cohort-overflow-v1','requiresOperatorReview',true,'recipientCountAtLeast',101))
        ON CONFLICT(data_schema,account_id,policy_version) DO UPDATE SET last_seen_at=clock_timestamp();
      CONTINUE;
    END IF;
    IF candidate_count BETWEEN 3 AND 100 AND recipients>=3 AND depleted_count>=2
      AND p_account_id=ANY(cohort_ids) THEN
      facts := jsonb_build_object('ruleId','proven-machine-free-rotation-v1',
        'keyHash',key_row.key_hash,'accountIds',cohort_ids,
        'recipientCount',recipients,'depletedAccountCount',depleted_count,'creationWindowHours',24);
      INSERT INTO opengeni_private.promotion_detector_observations(data_schema,account_id,policy_version,evidence)
        VALUES(target,p_account_id,'machine-rotation-v1',facts)
        ON CONFLICT(data_schema,account_id,policy_version) DO UPDATE
          SET evidence=excluded.evidence,last_seen_at=clock_timestamp();
      IF detector_mode='enforce' THEN
        -- The setter's CAS serializes with manual adjudication. Manual releases,
        -- denials and holds are never overwritten by automatic reevaluation.
        SELECT * INTO decision_row FROM promotion_decisions WHERE account_id=p_account_id;
        IF NOT FOUND OR decision_row.actor='service:promotion-detector' THEN
          IF NOT FOUND OR decision_row.decision='eligible' THEN
            PERFORM opengeni_private.set_promotion_decision(p_account_id,'held','machine-rotation-v1',
              'proven-machine-free-rotation-v1',facts,'service:promotion-detector',coalesce(decision_row.revision,0));
          END IF;
        END IF;
      END IF;
      EXIT;
    END IF;
  END LOOP;
  PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory);
EXCEPTION WHEN OTHERS THEN
  PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory);
  RAISE;
END $$;

DO $install$
DECLARE routine regprocedure; target text := current_schema();
BEGIN
  INSERT INTO opengeni_private.promotion_detector_settings(data_schema) VALUES(target) ON CONFLICT DO NOTHING;
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='opengeni_private' AND p.proname IN ('evaluate_promotion_abuse','set_promotion_detector_mode')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,%I,opengeni_private,pg_temp',routine,target);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',routine);
  END LOOP;
END $install$;

-- Preserve the authoritative grant seam: direct SQL free grants also evaluate.
DO $gate$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef(format('%I.free_plan_credit_eligible(uuid)',current_schema())::regprocedure)
    INTO definition;
  IF position('evaluate_promotion_abuse' IN definition)=0 THEN
    definition := replace(definition, 'BEGIN', 'BEGIN
  PERFORM opengeni_private.evaluate_promotion_abuse(p_account_id);');
    EXECUTE definition;
  END IF;
END $gate$;
