-- deployment-mode: rolling
-- Install the channel foreign key without scanning the populated sessions
-- table while holding ACCESS EXCLUSIVE. New writes are checked immediately;
-- migration 0223 performs the bounded online validation scan separately.
--
-- The equivalent auto-named constraint may already exist on a database that
-- applied the original unreleased 0220 migration. Preserve that validated
-- constraint instead of installing a duplicate.
SET LOCAL lock_timeout = '5s';

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
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
  ) THEN
    ALTER TABLE "sessions"
      ADD CONSTRAINT "sessions_channel_id_fk"
      FOREIGN KEY ("channel_id")
      REFERENCES "channels"("id")
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END
$migration$;