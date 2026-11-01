-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS credit_ledger_receipt_rows_idx
ON credit_ledger_entries USING btree (account_id, created_at)
WHERE amount_micros > 0 OR type IN ('credit_refund', 'credit_dispute_hold', 'byok_platform_fee');
