-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS model_call_facts_connection_occurred_idx
  ON model_call_facts(account_id, connection_id, occurred_at)
  WHERE connection_id IS NOT NULL;
