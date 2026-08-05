-- deployment-mode: maintenance
-- Durable organization/workspace/personal authority for Documents and chunks.
-- Existing workspace-visible rows remain workspace authority. Existing private
-- rows remain personal authority, anchored to their original workspace and
-- immutable creating subject. Collections/bases are not authority boundaries.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

-- Reject a mixed-version cutover before taking table locks. Repeat after the
-- locks to close the connect-before-lock race. Deployment still owns the
-- external stop/no-restart protocol after this migration commits.
DO $document_writer_drain_before_lock$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION 'document authority activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$document_writer_drain_before_lock$;

-- Both tables already use FORCE RLS. The migration role owns them but may not
-- be a superuser, so temporarily restore the ordinary owner bypass inside this
-- transaction. Runtime roles remain subject to RLS throughout the cutover.
-- The final policy block restores FORCE before this migration can commit.
ALTER TABLE "documents" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "document_chunks" NO FORCE ROW LEVEL SECURITY;

DO $document_writer_drain_after_lock$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION 'document authority activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$document_writer_drain_after_lock$;

-- This is a protocol cutover, not a replay adapter. Stop the API and every
-- worker, wait for all document-index Temporal workflows to close, and settle
-- every queued/indexing document before applying the migration. The row check
-- is the database-verifiable half of that drain and prevents a legacy
-- three-field activity payload from being resumed under the new authority
-- contract.
DO $document_index_drain$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "documents" WHERE "status" IN ('queued', 'indexing')
  ) THEN
    RAISE EXCEPTION 'migration 0165 requires every queued/indexing document to settle before cutover'
      USING ERRCODE = '55000',
        HINT = 'Stop API/workers, close document-index workflows, and retry after documents are ready or failed.';
  END IF;
END
$document_index_drain$;

ALTER TABLE "documents" ADD COLUMN "authority_kind" text;
ALTER TABLE "documents" ADD COLUMN "authority_workspace_id" uuid;
ALTER TABLE "documents" ADD COLUMN "authority_subject_id" text;

ALTER TABLE "document_chunks" ADD COLUMN "authority_kind" text;
ALTER TABLE "document_chunks" ADD COLUMN "authority_workspace_id" uuid;
ALTER TABLE "document_chunks" ADD COLUMN "authority_subject_id" text;

-- Deterministic legacy backfill. Migration 0126 already guarantees every
-- private row has a non-empty creator, so this never widens an ambiguous row.
UPDATE "documents"
SET "authority_kind" = CASE WHEN "visibility" = 'private' THEN 'personal' ELSE 'workspace' END,
    "authority_workspace_id" = "workspace_id",
    "authority_subject_id" = CASE WHEN "visibility" = 'private' THEN "created_by" ELSE NULL END;

-- The document is the canonical parent for every chunk identity field. Repair
-- any legacy drift before freezing future writes with the trigger below.
UPDATE "document_chunks" AS chunk
SET "account_id" = document."account_id",
    "workspace_id" = document."workspace_id",
    "base_id" = document."base_id",
    "file_id" = document."file_id"
FROM "documents" AS document
WHERE document."id" = chunk."document_id"
  AND (
    chunk."account_id" IS DISTINCT FROM document."account_id"
    OR chunk."workspace_id" IS DISTINCT FROM document."workspace_id"
    OR chunk."base_id" IS DISTINCT FROM document."base_id"
    OR chunk."file_id" IS DISTINCT FROM document."file_id"
  );

UPDATE "document_chunks" AS chunk
SET "authority_kind" = document."authority_kind",
    "authority_workspace_id" = document."authority_workspace_id",
    "authority_subject_id" = document."authority_subject_id"
FROM "documents" AS document
WHERE document."id" = chunk."document_id";

ALTER TABLE "documents" ALTER COLUMN "authority_kind" SET NOT NULL;
ALTER TABLE "documents" ALTER COLUMN "authority_kind" SET DEFAULT 'workspace';
ALTER TABLE "document_chunks" ALTER COLUMN "authority_kind" SET NOT NULL;
ALTER TABLE "document_chunks" ALTER COLUMN "authority_kind" SET DEFAULT 'workspace';

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_authority_workspace_fk"
  FOREIGN KEY ("authority_workspace_id", "account_id")
  REFERENCES "workspaces"("id", "account_id") ON DELETE RESTRICT;
ALTER TABLE "document_chunks"
  ADD CONSTRAINT "document_chunks_authority_workspace_fk"
  FOREIGN KEY ("authority_workspace_id", "account_id")
  REFERENCES "workspaces"("id", "account_id") ON DELETE RESTRICT;

ALTER TABLE "documents" ADD CONSTRAINT "documents_authority_chk" CHECK (
  ("authority_kind" = 'organization' AND "authority_workspace_id" IS NULL AND "authority_subject_id" IS NULL)
  OR ("authority_kind" = 'workspace' AND "authority_workspace_id" = "workspace_id" AND "authority_subject_id" IS NULL)
  OR (
    "authority_kind" = 'personal'
    AND "authority_workspace_id" = "workspace_id"
    AND NULLIF(btrim("authority_subject_id"), '') IS NOT NULL
    AND octet_length(convert_to("authority_subject_id", 'UTF8')) <= 1024
    AND "authority_subject_id" = "created_by"
  )
);
ALTER TABLE "documents" ADD CONSTRAINT "documents_authority_visibility_chk" CHECK (
  ("authority_kind" = 'personal') = ("visibility" = 'private')
);
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_authority_chk" CHECK (
  ("authority_kind" = 'organization' AND "authority_workspace_id" IS NULL AND "authority_subject_id" IS NULL)
  OR ("authority_kind" = 'workspace' AND "authority_workspace_id" = "workspace_id" AND "authority_subject_id" IS NULL)
  OR (
    "authority_kind" = 'personal'
    AND "authority_workspace_id" = "workspace_id"
    AND NULLIF(btrim("authority_subject_id"), '') IS NOT NULL
    AND octet_length(convert_to("authority_subject_id", 'UTF8')) <= 1024
  )
);

CREATE INDEX "documents_authority_idx" ON "documents" (
  "account_id", "authority_kind", "authority_workspace_id", "authority_subject_id", "status"
);
CREATE INDEX "document_chunks_authority_idx" ON "document_chunks" (
  "account_id", "authority_kind", "authority_workspace_id", "authority_subject_id"
);

CREATE OR REPLACE FUNCTION opengeni_private.apply_document_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.authority_kind IS DISTINCT FROM OLD.authority_kind
    OR NEW.authority_workspace_id IS DISTINCT FROM OLD.authority_workspace_id
    OR NEW.authority_subject_id IS DISTINCT FROM OLD.authority_subject_id
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.visibility IS DISTINCT FROM OLD.visibility
  ) THEN
    RAISE EXCEPTION 'document authority is immutable';
  END IF;

  IF NEW.authority_kind IS NULL OR (
    NEW.authority_kind = 'workspace'
    AND NEW.authority_workspace_id IS NULL
    AND NEW.visibility = 'private'
  ) THEN
    NEW.authority_kind := CASE WHEN NEW.visibility = 'private' THEN 'personal' ELSE 'workspace' END;
  END IF;
  CASE NEW.authority_kind
    WHEN 'organization' THEN
      NEW.authority_workspace_id := NULL;
      NEW.authority_subject_id := NULL;
      NEW.visibility := 'workspace';
    WHEN 'workspace' THEN
      NEW.authority_workspace_id := NEW.workspace_id;
      NEW.authority_subject_id := NULL;
      NEW.visibility := 'workspace';
    WHEN 'personal' THEN
      NEW.authority_workspace_id := NEW.workspace_id;
      NEW.authority_subject_id := coalesce(NULLIF(btrim(NEW.authority_subject_id), ''), NULLIF(btrim(NEW.created_by), ''));
      NEW.visibility := 'private';
    ELSE
      RAISE EXCEPTION 'invalid document authority kind: %', NEW.authority_kind;
  END CASE;
  RETURN NEW;
END
$$;

CREATE TRIGGER documents_authority_guard
BEFORE INSERT OR UPDATE ON "documents"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.apply_document_authority();

CREATE OR REPLACE FUNCTION opengeni_private.apply_document_chunk_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE parent "documents"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.authority_kind IS DISTINCT FROM OLD.authority_kind
    OR NEW.authority_workspace_id IS DISTINCT FROM OLD.authority_workspace_id
    OR NEW.authority_subject_id IS DISTINCT FROM OLD.authority_subject_id
    OR NEW.document_id IS DISTINCT FROM OLD.document_id
  ) THEN
    RAISE EXCEPTION 'document chunk authority is immutable';
  END IF;
  SELECT * INTO parent FROM "documents" WHERE "id" = NEW.document_id;
  IF NOT FOUND
    OR parent.account_id IS DISTINCT FROM NEW.account_id
    OR parent.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR parent.base_id IS DISTINCT FROM NEW.base_id
    OR parent.file_id IS DISTINCT FROM NEW.file_id
  THEN
    RAISE EXCEPTION 'document chunk parent identity mismatch';
  END IF;
  NEW.authority_kind := parent.authority_kind;
  NEW.authority_workspace_id := parent.authority_workspace_id;
  NEW.authority_subject_id := parent.authority_subject_id;
  RETURN NEW;
END
$$;

CREATE TRIGGER document_chunks_authority_guard
BEFORE INSERT OR UPDATE ON "document_chunks"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.apply_document_chunk_authority();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['documents', 'document_chunks'] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = current_schema() AND tablename = table_name
        AND policyname = 'workspace_isolation'
    ) THEN
      EXECUTE format('DROP POLICY workspace_isolation ON %I', table_name);
    END IF;
    EXECUTE format(
      'CREATE POLICY document_authority_isolation ON %I '
      || 'USING (opengeni_private.scoped_knowledge_scope_visible('
      || 'account_id, authority_kind, authority_workspace_id, authority_subject_id)) '
      || 'WITH CHECK (opengeni_private.scoped_knowledge_scope_visible('
      || 'account_id, authority_kind, authority_workspace_id, authority_subject_id))',
      table_name
    );
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END
$$;
