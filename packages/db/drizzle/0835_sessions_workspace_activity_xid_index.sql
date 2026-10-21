-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_workspace_activity_xid_idx ON sessions (workspace_id, activity_xid DESC, updated_at DESC, id DESC);
