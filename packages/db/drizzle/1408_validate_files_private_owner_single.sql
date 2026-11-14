-- deployment-mode: rolling
-- Validates the check 1407 added NOT VALID. Every existing private file has
-- one owner, because no writer has ever stored more. VALIDATE takes SHARE
-- UPDATE EXCLUSIVE, so reads and writes continue during the scan.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

ALTER TABLE files VALIDATE CONSTRAINT files_private_owner_single_chk;
