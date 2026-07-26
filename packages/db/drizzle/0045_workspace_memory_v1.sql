-- Workspace Memory V1.
-- Evolves the knowledge_memories table into an agent-writable, hybrid-searchable
-- memory store, and gives workspaces a growth-ready settings jsonb column.
-- Follows 0041_knowledge_layer.sql: IF NOT EXISTS column adds, current_schema()
-- guards, DO blocks for constraints. NO ANN index (3072 dims exceed pgvector's
-- HNSW cap; reads do a sequential cosine scan like document search). NO policy
-- changes (the table already has FORCE RLS + workspace_isolation from 0041).

-- Growth-ready per-workspace settings bag (holds memoryEnabled and future keys).
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "settings" jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Memory columns on the existing row (single short texts; no chunk table).
ALTER TABLE "knowledge_memories" ADD COLUMN IF NOT EXISTS "embedding" vector(3072);
ALTER TABLE "knowledge_memories" ADD COLUMN IF NOT EXISTS "embedding_model" text;
ALTER TABLE "knowledge_memories" ADD COLUMN IF NOT EXISTS "pinned" boolean NOT NULL DEFAULT false;
ALTER TABLE "knowledge_memories" ADD COLUMN IF NOT EXISTS "usage_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "knowledge_memories" ADD COLUMN IF NOT EXISTS "last_used_at" timestamptz;
ALTER TABLE "knowledge_memories" ADD COLUMN IF NOT EXISTS "supersedes_id" uuid;
ALTER TABLE "knowledge_memories" ADD COLUMN IF NOT EXISTS "superseded_by_id" uuid;
ALTER TABLE "knowledge_memories" ADD COLUMN IF NOT EXISTS "valid_from" timestamptz NOT NULL DEFAULT now();
ALTER TABLE "knowledge_memories" ADD COLUMN IF NOT EXISTS "valid_until" timestamptz;
-- Exact-dedup key. Hash of the NORMALIZED text, where normalization is
-- lower(collapse-internal-whitespace(trim(text))). The application computes the
-- IDENTICAL value in packages/core/src/domain/memory.ts (normalizeMemoryText +
-- hashMemoryText) so exact-dup detection matches across the migration backfill
-- and every runtime write. Keep the two in lockstep.
ALTER TABLE "knowledge_memories" ADD COLUMN IF NOT EXISTS "text_hash" text;

-- Supersession links (same table). ON DELETE SET NULL: dropping a record must not
-- cascade-delete its chain neighbours.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_memories_supersedes_fk'
  ) THEN
    ALTER TABLE "knowledge_memories" ADD CONSTRAINT "knowledge_memories_supersedes_fk"
      FOREIGN KEY ("supersedes_id") REFERENCES "knowledge_memories"("id") ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_memories_superseded_by_fk'
  ) THEN
    ALTER TABLE "knowledge_memories" ADD CONSTRAINT "knowledge_memories_superseded_by_fk"
      FOREIGN KEY ("superseded_by_id") REFERENCES "knowledge_memories"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- Working-set + dedup access paths.
CREATE INDEX IF NOT EXISTS "knowledge_memories_workspace_visible_idx"
  ON "knowledge_memories" ("workspace_id", "pinned" DESC, "updated_at" DESC)
  WHERE "status" IN ('active', 'approved');
CREATE INDEX IF NOT EXISTS "knowledge_memories_workspace_text_hash_idx"
  ON "knowledge_memories" ("workspace_id", "text_hash");
-- Enforce the exact-dedup invariant for the agent-visible set. Proposed and
-- terminal rows remain outside the constraint because agents cannot act on them.
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_memories_workspace_visible_text_hash_uq"
  ON "knowledge_memories" ("workspace_id", "text_hash")
  WHERE "status" IN ('active', 'approved') AND "text_hash" IS NOT NULL;

-- Backfill text_hash for pre-existing rows using the same normalization the app
-- applies at write time: lower(collapse-ws(trim(text))), sha256, hex-encoded.
-- Normalization MUST equal normalizeMemoryText in memory-domain.ts:
-- collapse every whitespace run to a single space, then trim, then lowercase.
--   JS:  text.replace(/\s+/g, " ").trim().toLowerCase()
--   SQL: lower(btrim(regexp_replace(text, '\s+', ' ', 'g')))
UPDATE "knowledge_memories"
  SET "text_hash" = encode(sha256(convert_to(lower(btrim(regexp_replace("text", '\s+', ' ', 'g'))), 'UTF8')), 'hex')
  WHERE "text_hash" IS NULL;
