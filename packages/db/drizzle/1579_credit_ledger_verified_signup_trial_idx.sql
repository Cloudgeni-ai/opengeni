-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS credit_ledger_verified_signup_trial_idx
ON credit_ledger_entries (account_id)
WHERE type = 'grant' AND source_type = 'verified_signup_trial';
