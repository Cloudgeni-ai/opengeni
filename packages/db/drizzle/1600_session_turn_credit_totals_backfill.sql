-- deployment-mode: rolling
-- opengeni:batched-backfill batch-size=1 lock-timeout=5s statement-timeout=120s
-- online-safety-exception: unbatched-data: each transaction completes one turn selected by LIMIT, committing before the next; it reads only that turn's records and holds only that turn's two totals rows from its recount to its commit.
-- Completes 1599's not-ready turn totals online: for one turn per
-- transaction, session_turn_credit_totals_recount locks the turn's two rows
-- (a writer of that turn waits at most for this one turn's recount), recounts
-- the turn's records in a snapshot taken after the locks and returns the
-- absolute sums, which this statement writes and marks ready. A turn whose
-- usage row is busy is retried; one not visible to the recount is left
-- inexact, so readers keep its full sum. Required before nothing: readers
-- recount a turn that is not ready. The owner writes the totals through its
-- owner policy; the statement scopes its transaction to the turn's account
-- and workspace (transaction-local), as the source tables' policies expect.
WITH next_turn AS MATERIALIZED (
  SELECT total.turn_id,
    set_config('opengeni.account_id', total.account_id::text, true) AS scoped_account,
    set_config('opengeni.workspace_id', total.workspace_id::text, true) AS scoped_workspace
  FROM session_turn_credit_totals total
  WHERE total.side = 'events' AND NOT total.ready AND total.exact
  ORDER BY total.turn_id
  LIMIT 1
), recount AS MATERIALIZED (
  SELECT next_turn.turn_id, recount.*
  FROM next_turn
  CROSS JOIN LATERAL opengeni_private.session_turn_credit_totals_recount(next_turn.turn_id) recount
), completed AS (
  UPDATE session_turn_credit_totals total
  SET ready = recount.counted,
    exact = recount.counted,
    unpriced_calls = CASE WHEN recount.counted AND total.side = 'events' THEN recount.unpriced_calls ELSE 0 END,
    probe_calls = CASE WHEN recount.counted AND total.side = 'events' THEN recount.probe_calls ELSE 0 END,
    model_micros = CASE WHEN recount.counted AND total.side = 'events' THEN recount.model_micros ELSE 0 END,
    fee_micros = CASE WHEN recount.counted AND total.side = 'events' THEN recount.fee_micros ELSE 0 END,
    input_tokens = CASE WHEN recount.counted AND total.side = 'events' THEN recount.input_tokens ELSE 0 END,
    output_tokens = CASE WHEN recount.counted AND total.side = 'events' THEN recount.output_tokens ELSE 0 END,
    web_search_micros = CASE WHEN recount.counted AND total.side = 'usage' THEN recount.web_search_micros ELSE 0 END,
    image_generation_micros = CASE WHEN recount.counted AND total.side = 'usage'
      THEN recount.image_generation_micros ELSE 0 END,
    other_micros = CASE WHEN recount.counted AND total.side = 'usage' THEN recount.other_micros ELSE 0 END,
    refund_rows = CASE WHEN recount.counted AND total.side = 'usage' THEN recount.refund_rows ELSE 0 END
  FROM recount
  WHERE total.turn_id = recount.turn_id AND recount.locked AND NOT total.ready AND total.exact
  RETURNING total.turn_id
)
SELECT turn_id FROM completed
UNION ALL
SELECT turn_id FROM next_turn WHERE NOT EXISTS (SELECT 1 FROM completed)
