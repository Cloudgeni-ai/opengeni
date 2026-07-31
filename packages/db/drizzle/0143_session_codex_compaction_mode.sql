-- deployment-mode: rolling
-- Freeze each session's Codex compaction strategy at create time.
-- Existing sessions stay on portable plaintext compaction so mid-session
-- provider switches remain available; new Codex sessions default to remote_v2
-- unless the workspace opts into portable.

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "codex_compaction_mode" text NOT NULL DEFAULT 'portable';

ALTER TABLE "sessions"
  DROP CONSTRAINT IF EXISTS "sessions_codex_compaction_mode_chk";

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_codex_compaction_mode_chk"
  CHECK ("codex_compaction_mode" IN ('remote_v2', 'portable'));

UPDATE "sessions"
SET "codex_compaction_mode" = 'portable'
WHERE "codex_compaction_mode" IS DISTINCT FROM 'portable'
  AND "codex_compaction_mode" IS DISTINCT FROM 'remote_v2';
