-- deployment-mode: rolling
-- Validates the check 1303 added NOT VALID. Every existing row satisfies the
-- narrower check it replaced. VALIDATE takes SHARE UPDATE EXCLUSIVE, so reads
-- and writes continue during the scan.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

ALTER TABLE session_turns VALIDATE CONSTRAINT session_turns_latency_mode_check;
