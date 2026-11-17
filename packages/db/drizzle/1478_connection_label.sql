-- deployment-mode: rolling
-- A person's own name for a connection (docs/connection-presentation.md,
-- "Naming a connection"). People and agents see it when the provider gives
-- no account identity, such as two API keys for the same server.
--
-- Rolling: one nullable column, no default, no backfill. The previous release
-- never reads or writes it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

-- The check is added NOT VALID: the new column is null in every existing row,
-- so there is nothing to scan for, and new writes are still checked.
ALTER TABLE connections
  ADD COLUMN label text,
  ADD CONSTRAINT connections_label_length_check
    CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 80) NOT VALID;

COMMENT ON COLUMN connections.label IS
  'The person''s own name for this connection, shown when the provider gives no account identity. Display only; never selects credentials.';
