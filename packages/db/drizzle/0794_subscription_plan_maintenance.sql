-- deployment-mode: rolling
-- Identity-only, bounded discovery. No enrollment, backfill or funding at migration time.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Compute both boundaries from the ORIGINAL UTC creation day/time, never the
-- previous clamped boundary. Jan 31 -> Feb 28 -> Mar 31 must not drift to Mar 28.
CREATE FUNCTION opengeni_private.subscription_plan_free_anniversary(p_created_at timestamptz, p_now timestamptz)
RETURNS TABLE (period_start timestamptz, period_end timestamptz)
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $body$
DECLARE anchor timestamp; sweep timestamp; month_start timestamp;
  candidate timestamp; next_month timestamp; original_day integer; original_time interval;
BEGIN
  IF NOT isfinite(p_created_at) OR NOT isfinite(p_now) OR p_created_at > p_now THEN
    RAISE EXCEPTION 'Invalid Free anniversary timestamps' USING ERRCODE = '22023';
  END IF;
  anchor := p_created_at AT TIME ZONE 'UTC';
  sweep := p_now AT TIME ZONE 'UTC';
  month_start := date_trunc('month', sweep);
  original_day := extract(day FROM anchor)::integer;
  original_time := anchor - date_trunc('day', anchor);
  candidate := month_start + (least(original_day, extract(day FROM month_start + interval '1 month - 1 day')::integer) - 1) * interval '1 day' + original_time;
  IF candidate > sweep THEN
    month_start := month_start - interval '1 month';
    candidate := month_start + (least(original_day, extract(day FROM month_start + interval '1 month - 1 day')::integer) - 1) * interval '1 day' + original_time;
  END IF;
  next_month := month_start + interval '1 month';
  period_start := candidate AT TIME ZONE 'UTC';
  period_end := (next_month + (least(original_day, extract(day FROM next_month + interval '1 month - 1 day')::integer) - 1) * interval '1 day' + original_time) AT TIME ZONE 'UTC';
  RETURN NEXT;
END $body$;
REVOKE ALL ON FUNCTION opengeni_private.subscription_plan_free_anniversary(timestamptz,timestamptz) FROM PUBLIC;

DO $install$
DECLARE data_schema text := current_schema(); table_name text; owner_name text;
BEGIN
  SELECT pg_get_userbyid(relowner) INTO STRICT owner_name FROM pg_class
    WHERE oid = format('%I.organization_plans', data_schema)::regclass;
  -- FORCE RLS also binds the NOSUPERUSER/NOBYPASSRLS migration owner. Only
  -- an owner-opened backend/transaction/schema capability permits this read;
  -- a caller-supplied GUC never enables a global policy. No global DML policy.
  FOREACH table_name IN ARRAY ARRAY['managed_accounts', 'organization_plans', 'plan_credit_periods', 'credit_ledger_entries'] LOOP
    EXECUTE format('CREATE POLICY subscription_plan_maintenance_inventory_read ON %I.%I FOR SELECT USING (%I.session_tenancy_fence_owner_policy_active(current_user, %L, %s::oid, NULL, true))',
      data_schema, table_name, data_schema, owner_name, data_schema::regnamespace::oid);
  END LOOP;
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.list_subscription_plan_maintenance_accounts(p_limit integer)
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
                      AND trial.idempotency_key = 'verified-signup-trial:v1:' || trial.source_id AND trial.amount_micros > 0)
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
  ALTER FUNCTION opengeni_private.list_subscription_plan_maintenance_accounts(integer) OWNER TO CURRENT_USER;
  REVOKE ALL ON FUNCTION opengeni_private.list_subscription_plan_maintenance_accounts(integer) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.list_subscription_plan_maintenance_accounts(integer) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_plan_free_anniversary(timestamptz,timestamptz) TO opengeni_app;
  END IF;
END $install$;
