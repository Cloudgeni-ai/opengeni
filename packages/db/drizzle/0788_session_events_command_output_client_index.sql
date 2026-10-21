-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_events_command_output_client_idx
ON session_events (workspace_id, session_id, client_event_id COLLATE "C", sequence)
WHERE type = 'sandbox.command.output.delta';
