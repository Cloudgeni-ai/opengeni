-- deployment-mode: rolling
-- Free monthly credit signup cutoff (OPE-929). Additive and inert until an
-- owner sets a cutoff: with no revision (or a NULL cutoff) Free eligibility
-- and the Free enrollment sweep are unchanged. With a cutoff, a NEW Free
-- period also requires the signup receipt's owner (auth_users row named by the
-- receipt's source_id) to have been created at or after the cutoff. Existing
-- periods, balances, spendability, paid plans and promotion holds are untouched.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- Append-only, owner-only history. The newest revision for a data schema is
-- the current setting; not_before NULL means no cutoff.
CREATE TABLE IF NOT EXISTS opengeni_private.free_credit_signup_cutoff_revisions (
  data_schema text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  not_before timestamptz,
  operator text NOT NULL CHECK (octet_length(operator) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (octet_length(reason) BETWEEN 6 AND 1000),
  database_role text NOT NULL DEFAULT session_user,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (data_schema, revision)
);
REVOKE ALL ON opengeni_private.free_credit_signup_cutoff_revisions FROM PUBLIC;

-- Owner-only, revision-fenced. p_expected_revision is the current revision
-- (0 before the first write); a stale value fails with 40001 and writes nothing.
CREATE OR REPLACE FUNCTION opengeni_private.set_free_credit_signup_cutoff(
  p_not_before timestamptz, p_operator text, p_reason text, p_expected_revision bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE target text := session_tenancy_fence_target_schema()::regnamespace::text;
  prior opengeni_private.free_credit_signup_cutoff_revisions%ROWTYPE;
  result opengeni_private.free_credit_signup_cutoff_revisions%ROWTYPE;
BEGIN
  IF p_expected_revision IS NULL THEN
    RAISE EXCEPTION 'Free credit signup cutoff requires the expected revision' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('free-credit-signup-cutoff:' || target, 0));
  SELECT * INTO prior FROM opengeni_private.free_credit_signup_cutoff_revisions
    WHERE data_schema = target ORDER BY revision DESC LIMIT 1;
  IF p_expected_revision <> coalesce(prior.revision, 0) THEN
    RAISE EXCEPTION 'Free credit signup cutoff changed' USING ERRCODE = '40001';
  END IF;
  INSERT INTO opengeni_private.free_credit_signup_cutoff_revisions
    (data_schema, revision, not_before, operator, reason)
  VALUES (target, coalesce(prior.revision, 0) + 1, p_not_before, p_operator, p_reason)
  RETURNING * INTO result;
  RETURN jsonb_build_object('revision', result.revision, 'notBefore', result.not_before,
    'previousRevision', coalesce(prior.revision, 0), 'previousNotBefore', prior.not_before,
    'operator', result.operator, 'changedAt', result.changed_at);
END $$;
REVOKE ALL ON FUNCTION opengeni_private.set_free_credit_signup_cutoff(timestamptz,text,text,bigint) FROM PUBLIC;
DO $pin_setter$ BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.set_free_credit_signup_cutoff(timestamptz,text,text,bigint) SET search_path = pg_catalog, %I, opengeni_private, pg_temp', current_schema());
END $pin_setter$;

-- Same body as 0981 + 0982 (abuse evaluation first, then holds, then the
-- signup receipt), plus the receipt owner's signup time when a cutoff is set.
-- getSpendableCreditBalance calls this only for detector side effects and
-- ignores the result, so the cutoff never changes already-issued funds.
CREATE OR REPLACE FUNCTION free_plan_credit_eligible(p_account_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE signup_not_before timestamptz;
BEGIN
  PERFORM opengeni_private.evaluate_promotion_abuse(p_account_id);
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Plan account scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM promotion_enforcement WHERE enabled) AND EXISTS
    (SELECT 1 FROM promotion_decisions WHERE account_id=p_account_id AND decision <> 'eligible') THEN
    RETURN false;
  END IF;
  SELECT cutoff.not_before INTO signup_not_before FROM opengeni_private.free_credit_signup_cutoff_revisions cutoff
    WHERE cutoff.data_schema = session_tenancy_fence_target_schema()::regnamespace::text
    ORDER BY cutoff.revision DESC LIMIT 1;
  RETURN EXISTS (SELECT 1 FROM credit_ledger_entries trial WHERE trial.account_id = p_account_id
    AND trial.type = 'grant' AND trial.source_type = 'verified_signup_trial'
    AND trial.idempotency_key = 'verified-signup-trial:v1:' || trial.source_id AND trial.amount_micros >= 0
    AND (signup_not_before IS NULL OR EXISTS (SELECT 1 FROM auth_users signup_owner
      WHERE signup_owner.id = trial.source_id AND signup_owner.created_at >= signup_not_before)));
END $body$;

DO $install$
DECLARE data_schema text := current_schema(); routine regprocedure;
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.list_subscription_plan_maintenance_accounts(p_limit integer)
    RETURNS TABLE (account_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
    DECLARE inventory_id uuid; sweep_time timestamptz := clock_timestamp(); signup_not_before timestamptz;
    BEGIN
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION 'Invalid subscription plan maintenance bound' USING ERRCODE = '22023';
      END IF;
      SELECT cutoff.not_before INTO signup_not_before FROM opengeni_private.free_credit_signup_cutoff_revisions cutoff
        WHERE cutoff.data_schema = %1$I.session_tenancy_fence_target_schema()::regnamespace::text
        ORDER BY cutoff.revision DESC LIMIT 1;
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
                      AND trial.idempotency_key = 'verified-signup-trial:v1:' || trial.source_id AND trial.amount_micros >= 0
                      AND (signup_not_before IS NULL OR EXISTS (SELECT 1 FROM %1$I.auth_users signup_owner
                        WHERE signup_owner.id = trial.source_id AND signup_owner.created_at >= signup_not_before)))
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
  -- CREATE OR REPLACE keeps owner/ACLs. Restore the pinned definer search path.
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = data_schema AND p.proname = 'free_plan_credit_eligible'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, %I, opengeni_private, pg_temp', routine, data_schema);
  END LOOP;
END $install$;
