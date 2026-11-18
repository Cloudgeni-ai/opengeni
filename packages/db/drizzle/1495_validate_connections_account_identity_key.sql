-- deployment-mode: rolling
-- Validates the check 1480 added NOT VALID. Every row written since stamps
-- either null or a 64-character hex key, and rows from before 1480 are null.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE connections VALIDATE CONSTRAINT connections_account_identity_key_check;
