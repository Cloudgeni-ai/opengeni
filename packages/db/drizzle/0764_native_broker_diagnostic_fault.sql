-- deployment-mode: maintenance
-- Retain the first initial-stderr/protocol fault. Native broker writers must
-- enforce this new fence; old writers cannot remain alongside the new path.
-- No existing event, receipt or command outcome is rewritten or settled.
SET LOCAL lock_timeout = '5s';
ALTER TABLE native_command_broker_entries
  DROP CONSTRAINT native_command_broker_entries_kind_check;
ALTER TABLE native_command_broker_entries
  ADD CONSTRAINT native_command_broker_entries_kind_check
    CHECK (kind IN ('request','frame','page','eof','control_reply','request_reply','stdin_reservation','diagnostic_fault')),
  ADD CONSTRAINT native_command_broker_diagnostic_fault_key
    CHECK (kind <> 'diagnostic_fault' OR entry_key = 'initial-stderr');
-- The existing sequence constraint makes diagnostic faults non-sequenced;
-- the existing primary key and append-only trigger preserve the first fault.
