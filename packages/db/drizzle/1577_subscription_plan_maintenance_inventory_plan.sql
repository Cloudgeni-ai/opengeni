-- deployment-mode: rolling
-- Plan shape of the subscription plan maintenance inventory (1494). The worker
-- calls it every minute; with few or no candidates, `ORDER BY account.id LIMIT`
-- inside the account branch made the planner pick nested loops that
-- re-scanned materialized plan_credit_periods and the whole credit ledger for
-- every account (prod: ~727 ms per call). Same result, cheaper plan:
--
-- - Free's freeCredit flag is read once per call instead of once per row.
-- - "No live period that ends after the sweep" reads the account's single open
--   period (plan_credit_periods_open_idx is unique on account_id WHERE
--   expired_at IS NULL, and period_end is NOT NULL), a point lookup.
-- - The account branch is filtered once in a MATERIALIZED CTE, then ordered and
--   limited, so the limit no longer drives a per-account nested loop.
-- - The verified signup trial check uses credit_ledger_verified_signup_trial_idx
--   (1578) once it exists; it is correct without it.
--
-- Everything else (signature, SECURITY DEFINER, search_path, owner fence,
-- bounds, filters, ordering) is unchanged from 1494.
DO $subscription_plan_maintenance_inventory_plan$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.list_subscription_plan_maintenance_accounts(p_limit integer)
    RETURNS TABLE (account_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
    DECLARE inventory_id uuid; sweep_time timestamptz := clock_timestamp(); signup_not_before timestamptz;
      free_credit boolean;
    BEGIN
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION 'Invalid subscription plan maintenance bound' USING ERRCODE = '22023';
      END IF;
      SELECT cutoff.not_before INTO signup_not_before FROM opengeni_private.free_credit_signup_cutoff_revisions cutoff
        WHERE cutoff.data_schema = %1$I.session_tenancy_fence_target_schema()::regnamespace::text
        ORDER BY cutoff.revision DESC LIMIT 1;
      free_credit := (opengeni_private.subscription_plan_definition('free')->>'freeCredit')::boolean;
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      RETURN QUERY
        WITH eligible AS MATERIALIZED (
          SELECT account.id AS account_id FROM %1$I.managed_accounts account
            LEFT JOIN %1$I.organization_plans state ON state.account_id = account.id
            CROSS JOIN LATERAL opengeni_private.subscription_plan_free_anniversary(account.created_at, greatest(account.created_at, sweep_time)) anniversary
            WHERE account.created_at <= sweep_time
              AND (state.account_id IS NULL
                OR (state.plan_key IN ('pro', 'max') AND state.status IN ('canceled', 'unpaid', 'incomplete_expired') AND state.current_period_end <= sweep_time)
                OR (state.plan_key = 'free' AND state.status IN ('active', 'trialing') AND state.stripe_subscription_id IS NULL
                  AND free_credit
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
                      AND receipt.idempotency_key = 'plan-credit:free:' || account.id::text || ':' || to_char(anniversary.period_start AT TIME ZONE 'UTC', 'YYYY-MM'))
                  AND opengeni_private.free_credit_card_ok(account.id, false)))
              AND coalesce((SELECT live.period_end FROM %1$I.plan_credit_periods live
                WHERE live.account_id = account.id AND live.expired_at IS NULL), '-infinity'::timestamptz) <= sweep_time
        )
        SELECT candidate.account_id FROM (
          (SELECT period.account_id FROM %1$I.plan_credit_periods period
            WHERE period.expired_at IS NULL AND period.period_end <= sweep_time
            ORDER BY period.period_end, period.account_id LIMIT p_limit)
          UNION
          (SELECT eligible.account_id FROM eligible ORDER BY eligible.account_id LIMIT p_limit)
        ) candidate ORDER BY candidate.account_id LIMIT p_limit;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END $body$;
  $create$, data_schema);
END $subscription_plan_maintenance_inventory_plan$;
