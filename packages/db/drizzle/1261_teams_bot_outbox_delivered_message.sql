-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS teams_bot_outbox_delivered_message
ON teams_bot_outbox USING btree (route_id, provider_message_id)
WHERE state = 'delivered' AND provider_message_id IS NOT NULL;
