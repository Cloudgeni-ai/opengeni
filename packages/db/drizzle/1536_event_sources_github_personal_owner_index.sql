-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS event_sources_github_personal_owner_uq
ON event_sources USING btree (workspace_id, owner_subject_id)
WHERE kind = 'github_personal';
