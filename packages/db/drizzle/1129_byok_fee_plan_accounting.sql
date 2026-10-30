-- deployment-mode: rolling
-- Own-key platform fees (byok_platform_fee debits) are paid only from paid
-- credit, and each fee row records how it was funded: planPaidMicros (an
-- active paid plan's credit, app use), creditPaidMicros (paid credits) and
-- unfundedMicros (fee debt). The database now agrees with that receipt:
--
-- * plan_period_usage counts only a fee's planPaidMicros against the monthly
--   allowance, so a fee is never paid twice (plan credit and credits) while a
--   paid plan is past due, and a leftover unrestricted Free period never pays
--   one.
-- * plan_app_general_balance never lets plan credit repay debt up to what API
--   work has spent plus own-key fee debt still owed (unfundedMicros less
--   feeDebtRepaidMicros), so fee debt waits for paid-for credit (the next
--   top-up) and is never repaid by plan credit at period expiry or in a new
--   period's opening debt. Fees paid in full never raise it. Fee debt is
--   read from the latest paid-credit receipt's running totals
--   (paidCreditTotals) plus any rows that can carry a receipt after it, so
--   it never grows with the number of fees. The app's balance read uses the
--   same terms (packages/db/src/credit-balances.ts).
--
-- Rolling: same-signature replacements of two function bodies. The previous
-- release never writes byok_platform_fee rows, so its results are unchanged.
-- See docs/billing-origin.md.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.plan_period_usage(p_period %1$I.plan_credit_periods, p_until timestamp with time zone) RETURNS bigint
        LANGUAGE sql STABLE
        SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
        AS $$
      SELECT CASE WHEN EXISTS (SELECT 1 FROM credit_ledger_entries
        WHERE id = p_period.grant_entry_id AND eligible_model_ids IS NOT NULL)
      THEN (SELECT coalesce(sum(a.amount_micros), 0)::bigint
        FROM credit_debit_allocations a JOIN credit_ledger_entries debit ON debit.id = a.debit_entry_id
        WHERE a.account_id = p_period.account_id AND a.grant_entry_id = p_period.grant_entry_id
          AND debit.type <> 'plan_credit_expiry'
          AND debit.usage_origin IS DISTINCT FROM 'api'
          AND debit.created_at < least(p_period.period_end, p_until))
      ELSE (
        SELECT greatest(0, coalesce(sum(CASE WHEN entry.type = 'byok_platform_fee'
            -- An own-key fee counts only what the paid plan paid of it.
            THEN coalesce((entry.metadata->>'planPaidMicros')::bigint, 0)
            ELSE -entry.amount_micros - coalesce(allocated.amount, 0) END), 0))::bigint
        FROM credit_ledger_entries entry
        LEFT JOIN LATERAL (SELECT sum(amount_micros) amount FROM credit_debit_allocations
          WHERE account_id = entry.account_id AND debit_entry_id = entry.id) allocated ON true
        WHERE entry.account_id = p_period.account_id
          AND entry.created_at >= greatest(p_period.period_start, p_period.granted_at)
          AND entry.created_at < least(p_period.period_end, p_until)
          AND entry.type NOT IN ('credit_topup','grant','manual_credit_grant','plan_credit_grant','plan_credit_expiry',
            'credit_refund','credit_dispute_hold','credit_dispute_release')
          -- Plan credit never pays for API work.
          AND entry.usage_origin IS DISTINCT FROM 'api'
          AND (entry.type <> 'video_generation_refund' OR EXISTS (
            SELECT 1 FROM credit_ledger_entries debit
            WHERE debit.account_id = entry.account_id AND debit.type = 'video_generation_debit'
              AND debit.source_type = entry.source_type AND debit.source_id = entry.source_id
              AND debit.usage_origin IS DISTINCT FROM 'api'
              AND debit.created_at >= greatest(p_period.period_start, p_period.granted_at)
              AND debit.created_at < least(p_period.period_end, p_until)))
      ) END
    $$;
  $create$, data_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.plan_app_general_balance(p_account_id uuid, p_plan_remaining bigint) RETURNS bigint
        LANGUAGE sql STABLE
        SET search_path TO 'pg_catalog', %1$I, 'opengeni_private', 'pg_temp'
        AS $$
      -- Debt up to what API work has spent plus own-key fee debt still owed
      -- is never repaid from plan credit.
      SELECT general + least(greatest(0, p_plan_remaining - general), credit_spent)
      FROM (SELECT opengeni_private.plan_general_balance(p_account_id) AS general,
        greatest(0,
          (SELECT coalesce(sum(-amount_micros)
              FILTER (WHERE usage_origin = 'api' AND type <> 'byok_platform_fee'), 0)
            FROM credit_ledger_entries WHERE account_id = p_account_id)
          -- Own-key fee debt still owed: the latest receipt's running totals
          -- (paidCreditTotals) plus rows that can carry a receipt after it.
          + (SELECT coalesce((latest.chain->>'unfunded')::bigint, 0)
              - coalesce((latest.chain->>'repaid')::bigint, 0)
              + coalesce(after.unfunded, 0) - coalesce(after.repaid, 0)
            FROM (SELECT 1) seed
            LEFT JOIN LATERAL (SELECT created_at, metadata->'paidCreditTotals' AS chain
              FROM credit_ledger_entries WHERE account_id = p_account_id
                AND (amount_micros > 0
                  OR type IN ('credit_refund', 'credit_dispute_hold', 'byok_platform_fee'))
                AND jsonb_typeof(metadata->'paidCreditTotals') = 'object'
              ORDER BY created_at DESC, metadata->'paidCreditTotals'->'n' DESC LIMIT 1) latest ON true
            CROSS JOIN LATERAL (SELECT coalesce(latest.created_at, '-infinity'::timestamptz) AS since OFFSET 0) bound
            CROSS JOIN LATERAL (SELECT sum((metadata->>'unfundedMicros')::bigint)
                FILTER (WHERE type = 'byok_platform_fee') AS unfunded,
              sum((metadata->>'feeDebtRepaidMicros')::bigint) AS repaid
              FROM credit_ledger_entries WHERE account_id = p_account_id
                AND (amount_micros > 0
                  OR type IN ('credit_refund', 'credit_dispute_hold', 'byok_platform_fee'))
                AND created_at > bound.since) after)) AS credit_spent) balances
    $$;
  $create$, data_schema);
END $install$;
