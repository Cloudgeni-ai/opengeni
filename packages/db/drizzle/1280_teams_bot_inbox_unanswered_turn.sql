-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS teams_bot_inbox_unanswered_turn
ON teams_bot_inbox USING btree (route_id, turn_id)
WHERE turn_id IS NOT NULL AND replied_at IS NULL;
