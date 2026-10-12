-- deployment-mode: rolling
-- Immutable operation-reply and per-command stdin-reservation indexes. Neither
-- changes existing entries or authorizes retry from provider acceptance alone.
SET LOCAL lock_timeout = '5s';
ALTER TABLE native_command_broker_entries
  DROP CONSTRAINT native_command_broker_entries_kind_check,
  DROP CONSTRAINT native_command_broker_entries_check;
ALTER TABLE native_command_broker_entries
  ADD CONSTRAINT native_command_broker_entries_kind_check
    CHECK (kind IN ('request','frame','page','eof','control_reply','request_reply','stdin_reservation')),
  ADD CONSTRAINT native_command_broker_entries_check
    CHECK ((kind IN ('request','frame','control_reply','request_reply','stdin_reservation')) = (sequence IS NOT NULL));
