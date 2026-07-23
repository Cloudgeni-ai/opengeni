-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "session_turn_attempts_human_input_owner_uq"
  ON "session_turn_attempts" (
    "account_id", "workspace_id", "session_id", "turn_id", "id"
  );
