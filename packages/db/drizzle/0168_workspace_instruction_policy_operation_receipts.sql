-- deployment-mode: rolling

-- Immutable revision and activation rows are also the durable receipts for
-- policy-administration mutations. Legacy rows remain untouched and project
-- their immutable row id as a compatibility operation identity; new writers
-- persist stable UUIDs plus a secret-safe fingerprint of the complete canonical
-- request so only byte-equivalent semantics can replay the original result.
ALTER TABLE "workspace_instruction_policy_revisions"
  ADD COLUMN IF NOT EXISTS "operation_id" uuid,
  ADD COLUMN IF NOT EXISTS "request_fingerprint" text;

ALTER TABLE "workspace_instruction_policy_revisions"
  ADD CONSTRAINT "workspace_instruction_policy_revisions_operation_receipt_chk"
  CHECK (
    ("operation_id" IS NULL AND "request_fingerprint" IS NULL)
    OR (
      "operation_id" IS NOT NULL
      AND "request_fingerprint" ~ '^[0-9a-f]{64}$'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  "workspace_instruction_policy_revisions_workspace_operation_uq"
  ON "workspace_instruction_policy_revisions" ("workspace_id", "operation_id")
  WHERE "operation_id" IS NOT NULL;

ALTER TABLE "workspace_instruction_policy_activation_events"
  ADD COLUMN IF NOT EXISTS "operation_id" uuid,
  ADD COLUMN IF NOT EXISTS "request_fingerprint" text;

ALTER TABLE "workspace_instruction_policy_activation_events"
  ADD CONSTRAINT "workspace_instruction_policy_events_operation_receipt_chk"
  CHECK (
    ("operation_id" IS NULL AND "request_fingerprint" IS NULL)
    OR (
      "operation_id" IS NOT NULL
      AND "request_fingerprint" ~ '^[0-9a-f]{64}$'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  "workspace_instruction_policy_events_workspace_operation_uq"
  ON "workspace_instruction_policy_activation_events" ("workspace_id", "operation_id")
  WHERE "operation_id" IS NOT NULL;