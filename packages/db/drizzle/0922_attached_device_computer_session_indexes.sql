-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS computer_sessions_device_workspace_idx
ON computer_sessions (device_workspace_id, device_id, lifecycle)
WHERE device_id IS NOT NULL;
