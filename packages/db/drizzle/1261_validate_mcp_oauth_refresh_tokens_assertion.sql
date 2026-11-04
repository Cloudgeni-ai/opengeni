-- deployment-mode: rolling
-- Validate the assertion check 1260 added NOT VALID. Every existing row has
-- neither new column set, so every row passes; this only scans under SHARE
-- UPDATE EXCLUSIVE and blocks no reads or writes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE mcp_oauth_refresh_tokens
  VALIDATE CONSTRAINT mcp_oauth_refresh_tokens_assertion_chk;
