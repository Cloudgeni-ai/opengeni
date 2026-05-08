CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "initial_message" text NOT NULL,
  "resources" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "tools" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "model" text NOT NULL,
  "sandbox_backend" text NOT NULL,
  "temporal_workflow_id" text,
  "active_turn_id" uuid,
  "last_sequence" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "tools" jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE IF NOT EXISTS "files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "status" text NOT NULL DEFAULT 'pending_upload',
  "filename" text NOT NULL,
  "safe_filename" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "sha256" text,
  "bucket" text NOT NULL,
  "object_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "files_object_key_idx" ON "files" ("object_key");
CREATE INDEX IF NOT EXISTS "files_status_idx" ON "files" ("status");
CREATE TABLE IF NOT EXISTS "file_uploads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "file_id" uuid NOT NULL REFERENCES "files"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'pending',
  "expires_at" timestamptz NOT NULL,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "file_uploads_file_id_idx" ON "file_uploads" ("file_id");
CREATE INDEX IF NOT EXISTS "file_uploads_status_idx" ON "file_uploads" ("status");
CREATE TABLE IF NOT EXISTS "document_bases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "base_id" uuid NOT NULL REFERENCES "document_bases"("id") ON DELETE CASCADE,
  "file_id" uuid NOT NULL REFERENCES "files"("id") ON DELETE RESTRICT,
  "status" text NOT NULL DEFAULT 'queued',
  "title" text NOT NULL,
  "parser" text NOT NULL DEFAULT 'liteparse',
  "chunk_count" integer NOT NULL DEFAULT 0,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "documents_base_file_idx" ON "documents" ("base_id", "file_id");
CREATE INDEX IF NOT EXISTS "documents_base_status_idx" ON "documents" ("base_id", "status");
CREATE TABLE IF NOT EXISTS "document_chunks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "base_id" uuid NOT NULL REFERENCES "document_bases"("id") ON DELETE CASCADE,
  "file_id" uuid NOT NULL REFERENCES "files"("id") ON DELETE RESTRICT,
  "chunk_index" integer NOT NULL,
  "text" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "embedding" vector(3072) NOT NULL,
  "embedding_model" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
DROP INDEX IF EXISTS "document_chunks_embedding_hnsw_idx";
DO $$
BEGIN
  BEGIN
    ALTER TABLE "document_chunks" ALTER COLUMN "embedding" TYPE vector(3072);
  EXCEPTION WHEN others THEN
    DELETE FROM "document_chunks";
    ALTER TABLE "document_chunks" ALTER COLUMN "embedding" TYPE vector(3072);
  END;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "document_chunks_document_index_idx" ON "document_chunks" ("document_id", "chunk_index");
CREATE INDEX IF NOT EXISTS "document_chunks_base_idx" ON "document_chunks" ("base_id");
CREATE TABLE IF NOT EXISTS "session_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "trigger_event_id" uuid NOT NULL,
  "temporal_workflow_id" text NOT NULL,
  "status" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "session_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "turn_id" uuid,
  "sequence" integer NOT NULL,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "client_event_id" text,
  "producer_id" text,
  "producer_seq" integer,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "agent_run_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "turn_id" uuid REFERENCES "session_turns"("id") ON DELETE SET NULL,
  "state_version" integer NOT NULL,
  "serialized_run_state" text NOT NULL,
  "pending_approvals" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "session_events_session_sequence_idx" ON "session_events" ("session_id", "sequence");
CREATE UNIQUE INDEX IF NOT EXISTS "session_events_client_event_idx" ON "session_events" ("session_id", "client_event_id") WHERE "client_event_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "session_events_producer_idx" ON "session_events" ("session_id", "producer_id", "producer_seq") WHERE "producer_id" IS NOT NULL AND "producer_seq" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "session_events_session_created_idx" ON "session_events" ("session_id", "created_at");
