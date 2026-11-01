-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_turns_billing_origin_latest_idx
ON session_turns USING btree (workspace_id, session_id, created_at DESC, id DESC)
WHERE billing_origin IS NOT NULL;
