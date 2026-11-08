-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_realtime_modes_incoming_call_idx
  ON session_realtime_modes (incoming_call_id) WHERE incoming_call_id IS NOT NULL;
