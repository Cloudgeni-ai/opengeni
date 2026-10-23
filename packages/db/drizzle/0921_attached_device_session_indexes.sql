-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS browser_sessions_device_workspace_idx
ON browser_sessions (device_workspace_id, device_id, lifecycle)
WHERE device_id IS NOT NULL;
