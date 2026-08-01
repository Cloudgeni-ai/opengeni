-- deployment-mode: rolling
-- Draft latency selection is additive; existing rows remain Standard.

ALTER TABLE composer_drafts
  ADD COLUMN latency_mode text NOT NULL DEFAULT 'standard',
  ADD CONSTRAINT composer_drafts_latency_mode_check
    CHECK (latency_mode IN ('standard', 'priority', 'fast'));

ALTER TABLE new_session_drafts
  ADD COLUMN latency_mode text NOT NULL DEFAULT 'standard',
  ADD CONSTRAINT new_session_drafts_latency_mode_check
    CHECK (latency_mode IN ('standard', 'priority', 'fast'));
