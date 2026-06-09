ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_kind" text NOT NULL DEFAULT 'manual_upload';
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_uri" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_external_id" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_title" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_author" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_created_at" timestamptz;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_updated_at" timestamptz;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_version" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "acl_tags" jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS "documents_source_kind_idx" ON "documents" ("source_kind");
CREATE INDEX IF NOT EXISTS "documents_source_external_id_idx" ON "documents" ("source_external_id");
CREATE INDEX IF NOT EXISTS "documents_acl_tags_idx" ON "documents" USING gin ("acl_tags");

CREATE INDEX IF NOT EXISTS "document_chunks_text_fts_idx" ON "document_chunks" USING gin (to_tsvector('simple', "text"));

CREATE TABLE IF NOT EXISTS "knowledge_memories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "status" text NOT NULL DEFAULT 'proposed',
  "kind" text NOT NULL DEFAULT 'semantic',
  "scope" text NOT NULL DEFAULT 'workspace',
  "text" text NOT NULL,
  "source_refs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "confidence" integer NOT NULL DEFAULT 50,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_by_session_id" uuid REFERENCES "sessions"("id") ON DELETE SET NULL,
  "reviewed_by" text,
  "reviewed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "knowledge_memories_status_idx" ON "knowledge_memories" ("status");
CREATE INDEX IF NOT EXISTS "knowledge_memories_kind_idx" ON "knowledge_memories" ("kind");
CREATE INDEX IF NOT EXISTS "knowledge_memories_scope_idx" ON "knowledge_memories" ("scope");
CREATE INDEX IF NOT EXISTS "knowledge_memories_created_by_session_idx" ON "knowledge_memories" ("created_by_session_id");
CREATE INDEX IF NOT EXISTS "knowledge_memories_text_fts_idx" ON "knowledge_memories" USING gin (to_tsvector('simple', "text"));
