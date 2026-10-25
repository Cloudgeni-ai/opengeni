-- deployment-mode: rolling
-- Validate the system_updates_kind_check 0972 re-added NOT VALID. Every
-- existing row already satisfied the narrower previous list, so validation only
-- proves it again. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, so reads
-- and writes continue while it scans.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60min';

ALTER TABLE "session_system_updates" VALIDATE CONSTRAINT "system_updates_kind_check";

RESET statement_timeout;
RESET lock_timeout;
