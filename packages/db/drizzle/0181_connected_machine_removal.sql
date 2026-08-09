-- deployment-mode: rolling

-- Connected-machine removal is a control-plane operation. The enrollment row
-- remains durable evidence; this receipt table makes retries deterministic and
-- preserves blocked dependency explanations without storing credentials.
CREATE TABLE "machine_removal_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "enrollment_id" uuid NOT NULL REFERENCES "enrollments"("id") ON DELETE RESTRICT,
  "operation_key" text NOT NULL,
  "request_fingerprint" text NOT NULL,
  "outcome" text NOT NULL,
  "result" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "machine_removal_operations_request_fingerprint_chk"
    CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "machine_removal_operations_operation_key_chk"
    CHECK (length(btrim("operation_key")) BETWEEN 1 AND 200
      AND "operation_key" = btrim("operation_key")),
  CONSTRAINT "machine_removal_operations_outcome_chk"
    CHECK ("outcome" IN ('removed', 'already_removed', 'blocked')),
  CONSTRAINT "machine_removal_operations_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "machine_removal_operations_workspace_operation_uq"
  ON "machine_removal_operations" ("workspace_id", "operation_key");
CREATE UNIQUE INDEX "machine_removal_operations_workspace_id_uq"
  ON "machine_removal_operations" ("workspace_id", "id");
CREATE INDEX "machine_removal_operations_enrollment_created_idx"
  ON "machine_removal_operations" ("workspace_id", "enrollment_id", "created_at");

ALTER TABLE "machine_removal_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "machine_removal_operations" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "machine_removal_operations"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.machine_removal_operations TO opengeni_app',
      target_schema
    );
  END IF;
END
$grants$;