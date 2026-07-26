-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY "session_attempt_interruptions_attempt_lookup_idx"
  ON "session_attempt_interruptions" ("workspace_id", "session_id", "attempt_id", "requested_at" DESC);
