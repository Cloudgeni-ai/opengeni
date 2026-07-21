-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY "session_events_workspace_session_type_sequence_idx"
  ON "session_events" ("workspace_id", "session_id", "type", "sequence" DESC);
