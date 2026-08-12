-- deployment-mode: rolling
-- Validate only the staged NOT VALID constraint. PostgreSQL performs this scan
-- with SHARE UPDATE EXCLUSIVE rather than retaining the column-addition
-- transaction's ACCESS EXCLUSIVE lock across the populated sessions table.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $migration$
DECLARE
  same_name_count integer;
  exact_count integer;
  validated_exact_count integer;
  constraint_name text;
  constraint_validated boolean;
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

  IF same_name_count <> exact_count OR exact_count <> 1 THEN
    RAISE EXCEPTION
      'expected exactly one compatible sessions channel foreign key, found % compatible among % named constraints',
      exact_count,
      same_name_count;
  END IF;

  SELECT constraint_row.conname, constraint_row.convalidated
  INTO constraint_name, constraint_validated
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

  IF NOT constraint_validated THEN
    EXECUTE format(
      'ALTER TABLE "sessions" VALIDATE CONSTRAINT %I',
      constraint_name
    );
  END IF;

  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE constraint_row.convalidated)::integer
  INTO exact_count, validated_exact_count
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

  SELECT count(*)::integer
  INTO same_name_count
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'sessions'::regclass
    AND constraint_row.conname IN ('sessions_channel_id_fk', 'sessions_channel_id_fkey');

  IF same_name_count <> 1 OR exact_count <> 1 OR validated_exact_count <> 1 THEN
    RAISE EXCEPTION
      'sessions channel foreign key validation did not produce exactly one validated exact constraint';
  END IF;
END
$migration$;
