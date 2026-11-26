-- deployment-mode: rolling
-- opengeni:batched-backfill batch-size=1 lock-timeout=5s statement-timeout=120s
-- online-safety-exception: unbatched-data: each transaction completes one account selected by LIMIT, committing before the next; it holds no lock while it reads the ledger and only that account's totals row lock from its update to its commit.
-- Completes 1576's per-account totals online: for one not-ready account per
-- transaction, adds the sums of its ledger rows written before the triggers
-- (the backlog, read in one snapshot with the row it is compared to) to the
-- latest row version and marks it ready. One account per transaction, so the
-- backfill never waits for a row lock while holding another (no deadlock with
-- writers) and a writer of that account waits at most for this single-row
-- update to commit. Required before nothing: readers recount a row that is not
-- ready. An account deleted meanwhile is skipped without ending the backfill.
-- The owner sees and writes the totals through its owner policy; the statement
-- also scopes its transaction to the account it completes
-- (opengeni.account_id, transaction-local), as the tenant policies expect.
WITH next_account AS MATERIALIZED (
  SELECT total.account_id,
    set_config('opengeni.account_id', total.account_id::text, true) AS scoped_account
  FROM credit_ledger_account_totals total
  WHERE NOT total.ready
  ORDER BY total.account_id
  LIMIT 1
), backlog AS MATERIALIZED (
  SELECT next_account.account_id, backlog.balance_micros, backlog.api_spent_micros
  FROM next_account
  CROSS JOIN LATERAL opengeni_private.credit_ledger_account_totals_backlog(next_account.account_id) backlog
), completed AS (
  UPDATE credit_ledger_account_totals total
  SET balance_micros = total.balance_micros + backlog.balance_micros,
    api_spent_micros = total.api_spent_micros + backlog.api_spent_micros,
    ready = true
  FROM backlog
  WHERE total.account_id = backlog.account_id AND NOT total.ready
  RETURNING total.account_id
)
SELECT account_id FROM completed
UNION ALL
SELECT account_id FROM next_account WHERE NOT EXISTS (SELECT 1 FROM completed)
