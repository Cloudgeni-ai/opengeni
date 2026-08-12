-- deployment-mode: rolling
-- Install the channel foreign key without scanning the populated sessions
-- table while holding ACCESS EXCLUSIVE. New writes are checked immediately;
-- migration 0223 performs the bounded online validation scan separately.
--
-- The equivalent auto-named constraint may already exist on a database that
-- applied the original unreleased 0220 migration. Preserve that validated
-- constraint only when its complete catalog semantics match this migration.
SET LOCAL lock_timeout = '5s';

DO $migration$
DECLARE
  same_name_count integer;
  exact_count integer;
BEGIN
  SELECT count(*)::integer
  INTO same_name_count
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'sessions'::regclass
    AND constraint_row.conname IN ('sessions_channel_id_fk', 'sessions_channel_id_fkey');

  SELECT count(*)::integer
  INTO exact_count
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
    AND constraint_row.confupdtype = 'a'
    AND constraint_row.confmatchtype = 's'
    AND NOT constraint_row.condeferrable
    AND NOT constraint_row.condeferred;

  IF same_name_count <> exact_count OR exact_count > 1 THEN
    RAISE EXCEPTION
      'sessions channel foreign key name is occupied by an incompatible constraint';
  END IF;

  IF exact_count = 0 THEN
    ALTER TABLE "sessions"
      ADD CONSTRAINT "sessions_channel_id_fk"
      FOREIGN KEY ("channel_id")
      REFERENCES "channels"("id")
      MATCH SIMPLE
      ON UPDATE NO ACTION
      ON DELETE SET NULL
      NOT DEFERRABLE
      NOT VALID;

    SELECT count(*)::integer
    INTO exact_count
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
      AND constraint_row.conname = 'sessions_channel_id_fk'
      AND cardinality(constraint_row.conkey) = 1
      AND cardinality(constraint_row.confkey) = 1
      AND local_column.attname = 'channel_id'
      AND referenced_column.attname = 'id'
      AND constraint_row.confdeltype = 'n'
      AND constraint_row.confupdtype = 'a'
      AND constraint_row.confmatchtype = 's'
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred;

    IF exact_count <> 1 THEN
      RAISE EXCEPTION 'failed to install the exact sessions channel foreign key';
    END IF;
  END IF;
END
$migration$;
