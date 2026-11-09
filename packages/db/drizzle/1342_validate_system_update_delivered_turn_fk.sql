-- deployment-mode: rolling
-- Validates the FK 1341 re-added NOT VALID. Every existing row satisfied the
-- identical reference it replaced. VALIDATE takes SHARE UPDATE EXCLUSIVE, so
-- reads and writes continue during the scan.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

ALTER TABLE session_system_updates
  VALIDATE CONSTRAINT system_updates_workspace_turn_fk;
