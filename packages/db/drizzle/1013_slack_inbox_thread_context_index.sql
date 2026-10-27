-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS slack_interaction_inbox_thread_context_idx
ON slack_interaction_inbox (connection_id, slack_channel_id, slack_thread_ts, created_at DESC)
WHERE slack_thread_ts IS NOT NULL;
