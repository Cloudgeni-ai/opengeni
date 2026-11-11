-- deployment-mode: rolling
-- Validates the check 1304 added NOT VALID. Every existing row satisfies the
-- narrower check it replaced.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE composer_drafts VALIDATE CONSTRAINT composer_drafts_latency_mode_check;
