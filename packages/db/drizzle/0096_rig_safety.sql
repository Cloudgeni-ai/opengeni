-- Rig authorization/recovery hardening (migration 0096).
--
-- Proposal idempotency is workspace-scoped, matching session-create keys: a
-- repeated client key identifies one durable rig_changes row. Authorization
-- provenance is persisted on scheduled tasks and frozen sessions so the worker
-- never infers permission from a rig reference and never decrypts rig-default
-- variable sets for a legacy/unvalidated binding.

ALTER TABLE "rig_changes" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
CREATE UNIQUE INDEX IF NOT EXISTS "rig_changes_workspace_idempotency_idx"
  ON "rig_changes" ("workspace_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "rig_default_variable_sets_authorized" boolean NOT NULL DEFAULT false;

ALTER TABLE "scheduled_tasks"
  ADD COLUMN IF NOT EXISTS "rig_default_variable_sets_authorized" boolean NOT NULL DEFAULT false;
