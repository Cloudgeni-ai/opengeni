-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS host_export_outbox_prune_idx
ON host_export_outbox (export_kind, export_cursor, enqueued_at)
WHERE export_cursor IS NOT NULL;
