-- deployment-mode: rolling
-- Identity-only, bounded discovery. No enrollment, backfill or funding at migration time.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $install$
DECLARE data_schema text := current_schema(); table_name text; owner_name text;
BEGIN
  SELECT pg_get_userbyid(relowner) INTO STRICT owner_name FROM pg_class
    WHERE oid = format('%I.organization_plans', data_schema)::regclass;
  -- FORCE RLS also binds the NOSUPERUSER/NOBYPASSRLS migration owner. Only
  -- an owner-opened backend/transaction/schema capability permits this read;
  -- a caller-supplied GUC never enables a global policy. No global DML policy.
  FOREACH table_name IN ARRAY ARRAY['organization_plans', 'plan_credit_periods', 'credit_ledger_entries'] LOOP
    EXECUTE format('CREATE POLICY subscription_plan_maintenance_inventory_read ON %I.%I FOR SELECT USING (%I.session_tenancy_fence_owner_policy_active(current_user, %L, %s::oid, NULL, true))',
      data_schema, table_name, data_schema, owner_name, data_schema::regnamespace::oid);
  END LOOP;
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.list_subscription_plan_maintenance_accounts(p_limit integer)
    RETURNS TABLE (account_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
    DECLARE inventory_id uuid; sweep_time timestamptz := clock_timestamp(); month_key text;
    BEGIN
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION 'Invalid subscription plan maintenance bound' USING ERRCODE = '22023';
      END IF;
      month_key := to_char(sweep_time AT TIME ZONE 'UTC', 'YYYY-MM');
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      RETURN QUERY
        SELECT candidate.account_id FROM (
          (SELECT period.account_id FROM %1$I.plan_credit_periods period
            WHERE period.expired_at IS NULL AND period.period_end <= sweep_time
            ORDER BY period.period_end, period.account_id LIMIT p_limit)
          UNION
          (SELECT trial.account_id FROM %1$I.credit_ledger_entries trial
            LEFT JOIN %1$I.organization_plans state ON state.account_id = trial.account_id
            WHERE trial.type = 'grant' AND trial.source_type = 'verified_signup_trial'
              -- Keep trial discovery indexable by the existing unique receipt
              -- key, without adding a blocking index build to the usage ledger.
              AND trial.idempotency_key >= 'verified-signup-trial:v1:'
              AND trial.idempotency_key < 'verified-signup-trial:v2:'
              AND trial.idempotency_key = 'verified-signup-trial:v1:' || trial.source_id
              AND trial.amount_micros > 0
              AND (opengeni_private.subscription_plan_definition('free')->>'freeCredit')::boolean
              AND (state.account_id IS NULL
                OR (state.plan_key = 'free' AND state.status IN ('active', 'trialing') AND state.stripe_subscription_id IS NULL)
                OR (state.plan_key IN ('pro', 'max') AND state.status = 'canceled' AND state.current_period_end <= sweep_time))
              AND NOT EXISTS (SELECT 1 FROM %1$I.plan_credit_periods receipt
                WHERE receipt.account_id = trial.account_id
                  AND receipt.idempotency_key = 'plan-credit:free:' || trial.account_id::text || ':' || month_key)
              AND NOT EXISTS (SELECT 1 FROM %1$I.plan_credit_periods live
                WHERE live.account_id = trial.account_id AND live.expired_at IS NULL AND live.period_end > sweep_time)
            ORDER BY trial.account_id LIMIT p_limit)
        ) candidate ORDER BY candidate.account_id LIMIT p_limit;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END $body$;
  $create$, data_schema);
  ALTER FUNCTION opengeni_private.list_subscription_plan_maintenance_accounts(integer) OWNER TO CURRENT_USER;
  REVOKE ALL ON FUNCTION opengeni_private.list_subscription_plan_maintenance_accounts(integer) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.list_subscription_plan_maintenance_accounts(integer) TO opengeni_app;
  END IF;
END $install$;
