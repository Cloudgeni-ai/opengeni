-- deployment-mode: rolling
-- Validate only the staged NOT VALID constraint. PostgreSQL performs this scan
-- with SHARE UPDATE EXCLUSIVE rather than retaining the column-addition
-- transaction's ACCESS EXCLUSIVE lock across the populated sessions table.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $migration$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT constraint_row.conname
    FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_attribute AS local_column
      ON local_column.attrelid = constraint_row.conrelid
     AND local_column.attnum = constraint_row.conkey[1]
    JOIN pg_catalog.pg_attribute AS referenced_column
      ON referenced_column.attrelid = constraint_row.confrelid
     AND referenced_column.attnum = constraint_row.confkey[1]
    WHERE constraint_row.conrelid = 'sessions'::regclass
      AND constraint_row.confrelid = 'channels'::regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.conname IN ('sessions_channel_id_fk', 'sessions_channel_id_fkey')
      AND cardinality(constraint_row.conkey) = 1
      AND cardinality(constraint_row.confkey) = 1
      AND local_column.attname = 'channel_id'
      AND referenced_column.attname = 'id'
      AND constraint_row.confdeltype = 'n'
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND NOT constraint_row.convalidated
  LOOP
    EXECUTE format(
      'ALTER TABLE "sessions" VALIDATE CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END
$migration$;