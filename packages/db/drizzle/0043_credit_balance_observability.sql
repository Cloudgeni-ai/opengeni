-- 0043_credit_balance_observability.sql
-- Cross-account billing balance reads for Prometheus gauges. This mirrors the
-- observability count SECURITY DEFINER functions so workers can refresh global
-- process metrics without disabling FORCE RLS on account-scoped tables.

CREATE OR REPLACE FUNCTION opengeni_private.credit_balance_by_account()
RETURNS TABLE (account_id uuid, balance_micros bigint)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT L.account_id, coalesce(sum(L.amount_micros), 0)::bigint AS balance_micros
  FROM credit_ledger_entries L
  GROUP BY L.account_id
  ORDER BY L.account_id;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.credit_balance_by_account() TO opengeni_app;
  END IF;
END $$;
