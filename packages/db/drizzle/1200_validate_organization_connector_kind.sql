-- deployment-mode: rolling
-- Validate the kind check 1199 added NOT VALID. Every existing row got the
-- default kind 'mcp', so every row passes; this only scans under SHARE UPDATE
-- EXCLUSIVE and blocks no reads or writes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_connectors
  VALIDATE CONSTRAINT organization_connectors_kind_chk;
