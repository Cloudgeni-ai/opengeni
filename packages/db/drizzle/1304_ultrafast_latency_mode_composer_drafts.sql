-- deployment-mode: rolling
-- Widens composer_drafts_latency_mode_check to accept 'ultrafast' (see 1302).
-- NOT VALID; 1309 validates it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE composer_drafts
  DROP CONSTRAINT composer_drafts_latency_mode_check,
  ADD CONSTRAINT composer_drafts_latency_mode_check
    CHECK (latency_mode IN ('standard', 'priority', 'fast', 'ultrafast')) NOT VALID;
