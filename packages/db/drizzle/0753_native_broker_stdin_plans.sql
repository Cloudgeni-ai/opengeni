-- deployment-mode: rolling
-- One original stdin admission owns a complete encrypted payload and byte
-- range; native frame chunks never mint replacement child admissions.
SET LOCAL lock_timeout = '5s';
ALTER TABLE native_command_broker_entries
  DROP CONSTRAINT native_command_broker_entries_kind_check;
ALTER TABLE native_command_broker_entries
  ADD CONSTRAINT native_command_broker_entries_kind_check
    CHECK (kind IN ('request','frame','page','eof','control_reply','request_reply','stdin_reservation','diagnostic_fault','stdin_plan','stdin_page'));
-- The existing sequence constraint keeps plans/pages non-sequenced. Scope,
-- authenticated encryption and the immutable-entry guard remain unchanged.
