-- deployment-mode: rolling
-- Add an immutable request-keyed index of committed native control responses.
-- Existing kinds, encrypted scope, append-only guards and input indexes remain.
-- This does not qualify a broker or authorize a retry of an unknown outcome.
SET LOCAL lock_timeout = '5s';
ALTER TABLE native_command_broker_entries
  DROP CONSTRAINT native_command_broker_entries_kind_check,
  DROP CONSTRAINT native_command_broker_entries_check;
ALTER TABLE native_command_broker_entries
  ADD CONSTRAINT native_command_broker_entries_kind_check
    CHECK (kind IN ('request','frame','page','eof','control_reply')),
  ADD CONSTRAINT native_command_broker_entries_check
    CHECK ((kind IN ('request','frame','control_reply')) = (sequence IS NOT NULL));
