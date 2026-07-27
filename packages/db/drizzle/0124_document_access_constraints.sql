-- deployment-mode: rolling
-- Document access and knowledge-drop state hardening.
--
-- The partial unique index is the database serialization point for concurrent
-- first knowledge drops. It deliberately covers only the reserved Default
-- base; users may still create separately named bases with their own naming
-- policy. Existing raced Default rows are consolidated before the index is
-- created, preserving one document per file where the retained base already
-- has the same file.

DO $$
DECLARE
  duplicate RECORD;
BEGIN
  FOR duplicate IN
    SELECT workspace_id, min(id) AS keep_id
    FROM document_bases
    WHERE lower(btrim(name)) = 'default'
    GROUP BY workspace_id
    HAVING count(*) > 1
  LOOP
    -- A file can only occur once in a base. Keep the lexicographically first
    -- Default row's document when an old race created the same file twice.
    DELETE FROM documents duplicate_document
    WHERE duplicate_document.workspace_id = duplicate.workspace_id
      AND duplicate_document.base_id <> duplicate.keep_id
      AND lower(btrim((SELECT name FROM document_bases WHERE id = duplicate_document.base_id))) = 'default'
      AND EXISTS (
        SELECT 1
        FROM documents retained_document
        WHERE retained_document.workspace_id = duplicate.workspace_id
          AND retained_document.base_id = duplicate.keep_id
          AND retained_document.file_id = duplicate_document.file_id
      );

    UPDATE documents
    SET base_id = duplicate.keep_id,
        updated_at = now()
    WHERE workspace_id = duplicate.workspace_id
      AND base_id <> duplicate.keep_id
      AND lower(btrim((SELECT name FROM document_bases WHERE id = base_id))) = 'default';

    UPDATE document_chunks chunk
    SET base_id = duplicate.keep_id
    WHERE chunk.workspace_id = duplicate.workspace_id
      AND chunk.base_id <> duplicate.keep_id
      AND EXISTS (
        SELECT 1
        FROM documents document
        WHERE document.id = chunk.document_id
          AND document.base_id = duplicate.keep_id
      );

    DELETE FROM document_bases base
    WHERE base.workspace_id = duplicate.workspace_id
      AND base.id <> duplicate.keep_id
      AND lower(btrim(base.name)) = 'default';
  END LOOP;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "document_bases_workspace_default_name_uq"
  ON "document_bases" ("workspace_id")
  WHERE lower(btrim("name")) = 'default';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'documents_visibility_chk'
      AND conrelid = 'documents'::regclass
  ) THEN
    ALTER TABLE "documents"
      ADD CONSTRAINT "documents_visibility_chk"
      CHECK ("visibility" IN ('workspace', 'private')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'documents_curation_status_chk'
      AND conrelid = 'documents'::regclass
  ) THEN
    ALTER TABLE "documents"
      ADD CONSTRAINT "documents_curation_status_chk"
      CHECK ("curation_status" IN ('none', 'pending', 'suggested', 'auto_filed', 'failed')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'documents_private_creator_chk'
      AND conrelid = 'documents'::regclass
  ) THEN
    ALTER TABLE "documents"
      ADD CONSTRAINT "documents_private_creator_chk"
      CHECK ("visibility" <> 'private' OR "created_by" IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'documents_topics_array_chk'
      AND conrelid = 'documents'::regclass
  ) THEN
    ALTER TABLE "documents"
      ADD CONSTRAINT "documents_topics_array_chk"
      CHECK (jsonb_typeof("topics") = 'array') NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'documents_curation_object_chk'
      AND conrelid = 'documents'::regclass
  ) THEN
    ALTER TABLE "documents"
      ADD CONSTRAINT "documents_curation_object_chk"
      CHECK ("curation" IS NULL OR jsonb_typeof("curation") = 'object') NOT VALID;
  END IF;
END
$$;

ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_visibility_chk";
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_curation_status_chk";
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_private_creator_chk";
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_topics_array_chk";
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_curation_object_chk";