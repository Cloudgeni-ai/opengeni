-- deployment-mode: rolling
-- Which base runtime tools every model request of a session carries. Existing
-- sessions keep revision 0 (list_models and privacy_facts in every request),
-- so no text an earlier request sent ever changes. A new session starts NULL
-- and its first turn attempt records the current revision once, before any
-- model request; a session that already ran an attempt (on the previous
-- release) records 0. The previous release never reads or sets the column.
-- Adding it with DEFAULT 0 stores 0 for existing rows without a rewrite;
-- dropping the default then leaves new rows NULL.
SET LOCAL lock_timeout = '5s';
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS first_request_tools_revision integer DEFAULT 0;
ALTER TABLE sessions
  ALTER COLUMN first_request_tools_revision DROP DEFAULT;
