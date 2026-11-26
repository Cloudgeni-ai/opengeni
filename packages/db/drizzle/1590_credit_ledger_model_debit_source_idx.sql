-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS credit_ledger_entries_model_debit_source_idx
ON credit_ledger_entries (account_id, source_id)
WHERE type = 'model_usage_debit' AND source_type = 'model_response' AND amount_micros < 0;
