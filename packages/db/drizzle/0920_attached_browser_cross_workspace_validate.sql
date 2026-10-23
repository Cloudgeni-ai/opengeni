-- deployment-mode: rolling
-- Validate the 0919 device-workspace checks in their own transaction:
-- VALIDATE scans under SHARE UPDATE EXCLUSIVE, so writers keep going. Every
-- row from before 0919 has no device workspace, which satisfies the check,
-- so this cannot fail.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '0';

ALTER TABLE browser_sessions
  VALIDATE CONSTRAINT browser_sessions_device_workspace_check;

ALTER TABLE computer_sessions
  VALIDATE CONSTRAINT computer_sessions_device_workspace_check;
