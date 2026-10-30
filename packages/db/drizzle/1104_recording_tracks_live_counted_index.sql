-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS recording_tracks_live_counted
ON recording_tracks USING btree (workspace_id, live_counted_at)
WHERE live_counted_at IS NOT NULL;
