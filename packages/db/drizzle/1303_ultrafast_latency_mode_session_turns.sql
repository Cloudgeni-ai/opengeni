-- deployment-mode: rolling
-- Widens session_turns_latency_mode_check to accept 'ultrafast' (see 1302).
-- NOT VALID; 1308 validates it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE session_turns
  DROP CONSTRAINT session_turns_latency_mode_check,
  ADD CONSTRAINT session_turns_latency_mode_check
    CHECK (latency_mode IN ('standard', 'priority', 'fast', 'ultrafast')) NOT VALID;
