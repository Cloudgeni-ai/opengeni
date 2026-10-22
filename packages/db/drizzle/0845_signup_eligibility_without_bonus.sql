-- deployment-mode: rolling
-- Reuse the canonical one-human/one-org receipt without issuing money. Old
-- readers already ignore zero-value grants; existing positive receipts stay intact.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- Keep a bootstrap model scope on the zero-value eligibility witness. It is
-- never a spendable promotional balance, but future Free grants need the list
-- when the deployment has not written a runtime promotion policy yet.
ALTER TABLE credit_ledger_entries DROP CONSTRAINT credit_ledger_scope_valid;
ALTER TABLE credit_ledger_entries ADD CONSTRAINT credit_ledger_scope_valid CHECK (
  eligible_model_ids IS NULL OR (
    ((type IN ('grant', 'plan_credit_grant') AND amount_micros > 0)
      OR (type = 'grant' AND amount_micros = 0 AND source_type IS NOT DISTINCT FROM 'verified_signup_trial'
        AND source_id IS NOT NULL AND idempotency_key = 'verified-signup-trial:v1:' || source_id))
    AND cardinality(eligible_model_ids) BETWEEN 1 AND 40
    AND array_position(eligible_model_ids, NULL) IS NULL
    AND array_position(eligible_model_ids, '') IS NULL)
);

CREATE OR REPLACE FUNCTION opengeni_private.grant_verified_signup_trial_credit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE verified_owner boolean; account_owner boolean; inserted_count integer; model_ids jsonb;
BEGIN
  -- The legacy environment flag and runtime money-grant switch no longer gate
  -- this non-monetary eligibility witness. Neither can re-enable a bonus.
  SELECT candidate.email_verified IS TRUE INTO verified_owner
    FROM auth_users candidate WHERE candidate.id = NEW.auth_user_id;
  SELECT account.external_source = 'better-auth:user' AND account.external_id = NEW.auth_user_id
    INTO account_owner FROM managed_accounts account WHERE account.id = NEW.account_id;
  IF verified_owner IS DISTINCT FROM TRUE OR account_owner IS DISTINCT FROM TRUE
    OR opengeni_private.current_subject_id() IS DISTINCT FROM 'user:' || NEW.auth_user_id
    OR opengeni_private.current_account_id() IS DISTINCT FROM NEW.account_id
    OR NEW.result ->> 'organizationId' IS DISTINCT FROM NEW.account_id::text THEN
    RAISE EXCEPTION 'verified signup eligibility requires an exact new owner' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(policy->'signupModelIds', policy->'defaultModelIds') INTO model_ids
    FROM opengeni_private.credit_promotion_policy_revisions ORDER BY revision DESC LIMIT 1;
  model_ids := coalesce(model_ids, nullif(pg_catalog.current_setting('opengeni.signup_credit_model_ids', true), '')::jsonb);
  INSERT INTO credit_ledger_entries(account_id, workspace_id, type, amount_micros, source_type, source_id,
    idempotency_key, metadata, eligible_model_ids)
  VALUES (NEW.account_id, NULL, 'grant', 0, 'verified_signup_trial', NEW.auth_user_id,
    'verified-signup-trial:v1:' || NEW.auth_user_id,
    jsonb_build_object('campaign','free_plan_eligibility_v1','creditOfferLabel','Free plan eligibility'),
    CASE WHEN model_ids IS NULL THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(model_ids)) END)
  ON CONFLICT (idempotency_key) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count <> 1 THEN
    RAISE EXCEPTION 'verified signup eligibility idempotency collision' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $body$;

CREATE OR REPLACE FUNCTION free_plan_credit_eligible(p_account_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Plan account scope mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN EXISTS (SELECT 1 FROM credit_ledger_entries WHERE account_id = p_account_id
    AND type = 'grant' AND source_type = 'verified_signup_trial'
    AND idempotency_key = 'verified-signup-trial:v1:' || source_id AND amount_micros >= 0);
END $body$;

-- Discovery must use the same zero-or-legacy-positive eligibility rule as the
-- tenant recheck, otherwise already-enrolled Free accounts never renew.
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
