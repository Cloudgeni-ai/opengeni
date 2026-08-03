-- deployment-mode: rolling

-- Immutable revision and activation rows are also the durable receipts for
-- policy-administration mutations. Legacy rows remain untouched and project
-- their immutable row id as a compatibility operation identity; new writers
-- persist stable UUIDs for exact replay.
ALTER TABLE "workspace_instruction_policy_revisions"
  ADD COLUMN IF NOT EXISTS "operation_id" uuid;

CREATE UNIQUE INDEX IF NOT EXISTS
  "workspace_instruction_policy_revisions_workspace_operation_uq"
  ON "workspace_instruction_policy_revisions" ("workspace_id", "operation_id")
  WHERE "operation_id" IS NOT NULL;

ALTER TABLE "workspace_instruction_policy_activation_events"
  ADD COLUMN IF NOT EXISTS "operation_id" uuid;

CREATE UNIQUE INDEX IF NOT EXISTS
  "workspace_instruction_policy_events_workspace_operation_uq"
  ON "workspace_instruction_policy_activation_events" ("workspace_id", "operation_id")
  WHERE "operation_id" IS NOT NULL;