-- deployment-mode: rolling
-- Add a database-assigned completion order for successful document indexing.
-- A trigger stamps both current and old application writers only when status
-- transitions to ready, so metadata refreshes and base moves cannot advance an
-- agent's review checkpoint.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "documents" ADD COLUMN "index_sequence" bigint;
ALTER TABLE "documents" ADD COLUMN "indexed_at" timestamptz;

CREATE SEQUENCE "document_index_completion_seq" AS bigint;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (ORDER BY updated_at, id)::bigint AS index_sequence
  FROM documents
  WHERE status = 'ready'
)
UPDATE documents document
SET
  index_sequence = ranked.index_sequence,
  indexed_at = document.updated_at
FROM ranked
WHERE document.id = ranked.id;

SELECT setval(
  'document_index_completion_seq',
  greatest(coalesce((SELECT max(index_sequence) + 1 FROM documents), 1), 1),
  false
);

CREATE OR REPLACE FUNCTION opengeni_private.stamp_document_index_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'ready' THEN
      NEW.index_sequence := nextval('document_index_completion_seq');
      NEW.indexed_at := clock_timestamp();
    ELSE
      NEW.index_sequence := NULL;
      NEW.indexed_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'ready' AND OLD.status IS DISTINCT FROM 'ready' THEN
    NEW.index_sequence := nextval('document_index_completion_seq');
    NEW.indexed_at := clock_timestamp();
  ELSE
    NEW.index_sequence := OLD.index_sequence;
    NEW.indexed_at := OLD.indexed_at;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION opengeni_private.stamp_document_index_completion() FROM PUBLIC;

CREATE TRIGGER documents_index_completion_stamp
BEFORE INSERT OR UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION opengeni_private.stamp_document_index_completion();

ALTER TABLE documents ADD CONSTRAINT documents_index_sequence_chk CHECK (
  (index_sequence IS NULL OR index_sequence > 0)
  AND (
    status <> 'ready'
    OR (index_sequence IS NOT NULL AND indexed_at IS NOT NULL)
  )
);

CREATE INDEX documents_account_index_sequence_idx
  ON documents (account_id, index_sequence)
  WHERE status = 'ready' AND index_sequence IS NOT NULL;

COMMENT ON COLUMN documents.index_sequence IS
  'Database-assigned order of the latest successful transition to ready; immutable until the next successful reindex.';
COMMENT ON COLUMN documents.indexed_at IS
  'Database timestamp of the latest successful transition to ready.';