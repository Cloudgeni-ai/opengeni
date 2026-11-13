-- deployment-mode: rolling
-- Validates the check 1401 added NOT VALID. Every existing row has both
-- columns null, so it satisfies it. VALIDATE takes SHARE UPDATE EXCLUSIVE, so
-- reads and writes continue during the scan.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

ALTER TABLE connections VALIDATE CONSTRAINT connections_list_price_chk;
