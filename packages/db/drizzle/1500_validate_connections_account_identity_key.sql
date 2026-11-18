-- deployment-mode: rolling
-- Validates the check 1480 added NOT VALID. The check has been enforced on
-- every write since 1480, and rows from before 1480 are null, so nothing can
-- fail. VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE on connections:
-- reads and writes continue while it scans.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE connections VALIDATE CONSTRAINT connections_account_identity_key_check;
