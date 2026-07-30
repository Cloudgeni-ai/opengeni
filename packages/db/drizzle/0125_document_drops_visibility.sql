-- deployment-mode: rolling
-- Knowledge drops: auto-curation + per-document visibility.
-- Follows 0041_knowledge_layer.sql conventions: IF NOT EXISTS column adds only.
-- NO policy changes (documents already has FORCE RLS + workspace_isolation from 0041).
--
-- visibility: 'workspace' (anyone in the workspace) | 'private' (creator only).
-- created_by: the access-grant subject id that created the document (text — subject
--   ids are labels like 'dev' or 'api_key:<uuid>', not uuids). NULL for pre-existing
--   rows, which stay workspace-visible.
-- agent_access: whether agent retrieval surfaces (docs MCP tools) may return the
--   document. Humans keep REST access regardless.
-- curation_status: 'none' (ordinary add, caller supplied metadata) | 'pending'
--   (dropped, awaiting auto-curation) | 'suggested' (curated; base move NOT applied)
--   | 'auto_filed' (curated and moved to the suggested base) | 'failed' (curation
--   errored; document still indexes).
-- curation: the curator output audit blob {suggestedBaseId, suggestedBaseName,
--   confidence, reason, originalTitle, model}.

ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "visibility" text NOT NULL DEFAULT 'workspace';
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "created_by" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "agent_access" boolean NOT NULL DEFAULT true;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "summary" text;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "topics" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "curation_status" text NOT NULL DEFAULT 'none';
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "curation" jsonb;

-- Drop review surface: list pending/suggested drops per workspace cheaply.
CREATE INDEX IF NOT EXISTS "documents_workspace_curation_status_idx"
  ON "documents" ("workspace_id", "curation_status");
