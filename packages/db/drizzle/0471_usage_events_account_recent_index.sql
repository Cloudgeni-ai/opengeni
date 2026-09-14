-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS "usage_events_account_recent_idx"
  ON "usage_events" ("account_id", "occurred_at" DESC, "recorded_at" DESC);