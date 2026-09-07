-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS new_session_drafts_project_provenance_backfill_v1_idx
ON new_session_drafts (id)
WHERE session_options ? 'selectedProjectChannelId';
