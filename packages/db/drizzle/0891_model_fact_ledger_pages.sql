-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
-- opengeni:pre-release
CREATE INDEX CONCURRENTLY IF NOT EXISTS usage_events_workspace_metric_page_idx
ON usage_events (workspace_id, event_type, occurred_at, id);
