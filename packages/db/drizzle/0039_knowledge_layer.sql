ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_kind" text NOT NULL DEFAULT 'manual_upload';
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_uri" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_external_id" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_title" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_author" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_created_at" timestamptz;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_updated_at" timestamptz;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_version" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "acl_tags" jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS "documents_workspace_source_kind_idx" ON "documents" ("workspace_id", "source_kind");
CREATE INDEX IF NOT EXISTS "documents_workspace_source_external_id_idx" ON "documents" ("workspace_id", "source_external_id");
CREATE INDEX IF NOT EXISTS "documents_acl_tags_idx" ON "documents" USING gin ("acl_tags");
CREATE INDEX IF NOT EXISTS "document_chunks_text_fts_idx" ON "document_chunks" USING gin (to_tsvector('simple', "text"));

CREATE TABLE IF NOT EXISTS "knowledge_memories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_memories_workspace_account_fk'
  ) THEN
    ALTER TABLE "knowledge_memories" ADD CONSTRAINT "knowledge_memories_workspace_account_fk"
      FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "knowledge_memories_workspace_status_idx" ON "knowledge_memories" ("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "knowledge_memories_workspace_kind_idx" ON "knowledge_memories" ("workspace_id", "kind");
CREATE INDEX IF NOT EXISTS "knowledge_memories_workspace_scope_idx" ON "knowledge_memories" ("workspace_id", "scope");
CREATE INDEX IF NOT EXISTS "knowledge_memories_workspace_created_by_session_idx" ON "knowledge_memories" ("workspace_id", "created_by_session_id");
CREATE INDEX IF NOT EXISTS "knowledge_memories_text_fts_idx" ON "knowledge_memories" USING gin (to_tsvector('simple', "text"));

ALTER TABLE "knowledge_memories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_memories" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'knowledge_memories' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "knowledge_memories";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "knowledge_memories"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
