-- deployment-mode: rolling
-- Account-level governance lock and human-custodian recovery. Sensitive
-- approval evidence is stored only as an authenticated AES-GCM envelope by the
-- application; the database exposes account-scoped metadata under FORCE RLS.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "managed_accounts"
  ADD COLUMN IF NOT EXISTS "organization_kind" text,
  ADD COLUMN IF NOT EXISTS "governance_state" text,
  ADD COLUMN IF NOT EXISTS "governance_revision" bigint,
  ADD COLUMN IF NOT EXISTS "recovery_policy_revision" bigint,
  ADD COLUMN IF NOT EXISTS "recovery_quorum" integer,
  ADD COLUMN IF NOT EXISTS "governance_authority_subject_id" text,
  ADD COLUMN IF NOT EXISTS "authorization_invalidated_at" timestamptz;

UPDATE "managed_accounts"
SET
  "organization_kind" = coalesce(
    "organization_kind",
    CASE WHEN "external_source" = 'better-auth:user' THEN 'personal' ELSE 'team' END
  ),
  "governance_state" = coalesce("governance_state", 'active'),
  "governance_revision" = coalesce("governance_revision", 0),
  "recovery_policy_revision" = coalesce("recovery_policy_revision", 0),
  "governance_authority_subject_id" = coalesce(
    "governance_authority_subject_id",
    CASE
      WHEN "external_source" = 'better-auth:user' AND "external_id" IS NOT NULL
      THEN 'user:' || "external_id"
      ELSE NULL
    END
  );

ALTER TABLE "managed_accounts"
  ALTER COLUMN "organization_kind" SET DEFAULT 'team',
  ALTER COLUMN "organization_kind" SET NOT NULL,
  ALTER COLUMN "governance_state" SET DEFAULT 'active',
  ALTER COLUMN "governance_state" SET NOT NULL,
  ALTER COLUMN "governance_revision" SET DEFAULT 0,
  ALTER COLUMN "governance_revision" SET NOT NULL,
  ALTER COLUMN "recovery_policy_revision" SET DEFAULT 0,
  ALTER COLUMN "recovery_policy_revision" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE c.conname = 'managed_accounts_organization_kind_check'
      AND n.nspname = current_schema()
      AND r.relname = 'managed_accounts'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK ("organization_kind" IN (''personal'', ''team''))',
      current_schema(), 'managed_accounts', 'managed_accounts_organization_kind_check'
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE c.conname = 'managed_accounts_governance_state_check'
      AND n.nspname = current_schema()
      AND r.relname = 'managed_accounts'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK ("governance_state" IN (''active'', ''governance_locked''))',
      current_schema(), 'managed_accounts', 'managed_accounts_governance_state_check'
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE c.conname = 'managed_accounts_governance_revision_check'
      AND n.nspname = current_schema()
      AND r.relname = 'managed_accounts'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK ("governance_revision" >= 0 AND "recovery_policy_revision" >= 0)',
      current_schema(), 'managed_accounts', 'managed_accounts_governance_revision_check'
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE c.conname = 'managed_accounts_recovery_quorum_check'
      AND n.nspname = current_schema()
      AND r.relname = 'managed_accounts'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK ("recovery_quorum" IS NULL OR "recovery_quorum" BETWEEN 1 AND 10)',
      current_schema(), 'managed_accounts', 'managed_accounts_recovery_quorum_check'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "organization_recovery_custodians" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "subject_id" text NOT NULL,
  "subject_label" text,
  "policy_revision" bigint NOT NULL CHECK ("policy_revision" > 0),
  "enrolled_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_recovery_custodians_account_subject_uq"
    UNIQUE ("account_id", "subject_id")
);
CREATE INDEX IF NOT EXISTS "organization_recovery_custodians_account_policy_idx"
  ON "organization_recovery_custodians" ("account_id", "policy_revision");

CREATE TABLE IF NOT EXISTS "organization_recovery_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "state" text NOT NULL DEFAULT 'pending',
  "governance_revision" bigint NOT NULL,
  "policy_revision" bigint NOT NULL,
  "quorum" integer NOT NULL,
  "requested_by_subject_id" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "finalized_at" timestamptz,
  "cancelled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_recovery_operations_state_check"
    CHECK ("state" IN ('pending', 'finalized', 'cancelled')),
  CONSTRAINT "organization_recovery_operations_revisions_check"
    CHECK ("governance_revision" >= 0 AND "policy_revision" > 0 AND "quorum" BETWEEN 1 AND 10),
  CONSTRAINT "organization_recovery_operations_id_account_uq" UNIQUE ("id", "account_id")
);
CREATE INDEX IF NOT EXISTS "organization_recovery_operations_account_state_idx"
  ON "organization_recovery_operations" ("account_id", "state");
CREATE UNIQUE INDEX IF NOT EXISTS "organization_recovery_operations_one_pending_uq"
  ON "organization_recovery_operations" ("account_id") WHERE "state" = 'pending';

CREATE TABLE IF NOT EXISTS "organization_recovery_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "operation_id" uuid NOT NULL,
  "subject_id" text NOT NULL,
  "evidence_ciphertext" text NOT NULL,
  "evidence_key_version" text NOT NULL,
  "evidence_expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_recovery_approvals_operation_subject_uq"
    UNIQUE ("operation_id", "subject_id"),
  CONSTRAINT "organization_recovery_approvals_operation_account_fk"
    FOREIGN KEY ("operation_id", "account_id")
    REFERENCES "organization_recovery_operations"("id", "account_id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "organization_recovery_approvals_account_operation_idx"
  ON "organization_recovery_approvals" ("account_id", "operation_id");

CREATE TABLE IF NOT EXISTS "organization_governance_commands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "subject_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "command_type" text NOT NULL,
  "request_hash" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_governance_commands_account_subject_key_uq"
    UNIQUE ("account_id", "subject_id", "idempotency_key")
);

CREATE TABLE IF NOT EXISTS "organization_authorization_invalidations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "operation_id" uuid,
  "governance_revision" bigint NOT NULL,
  "reason" text NOT NULL,
  "invalidated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_authorization_invalidations_account_revision_uq"
    UNIQUE ("account_id", "governance_revision"),
  CONSTRAINT "organization_authorization_invalidations_operation_account_fk"
    FOREIGN KEY ("operation_id", "account_id")
    REFERENCES "organization_recovery_operations"("id", "account_id") ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS "organization_recovery_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "operation_id" uuid,
  "subject_id" text NOT NULL,
  "action" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_recovery_audit_operation_account_fk"
    FOREIGN KEY ("operation_id", "account_id")
    REFERENCES "organization_recovery_operations"("id", "account_id") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS "organization_recovery_audit_account_created_idx"
  ON "organization_recovery_audit" ("account_id", "created_at");

CREATE OR REPLACE FUNCTION opengeni_private.reject_organization_recovery_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'organization recovery history is append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS "organization_recovery_audit_append_only" ON "organization_recovery_audit";
CREATE TRIGGER "organization_recovery_audit_append_only"
  BEFORE UPDATE OR DELETE ON "organization_recovery_audit"
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_organization_recovery_history_mutation();

DROP TRIGGER IF EXISTS "organization_authorization_invalidations_append_only"
  ON "organization_authorization_invalidations";
CREATE TRIGGER "organization_authorization_invalidations_append_only"
  BEFORE UPDATE OR DELETE ON "organization_authorization_invalidations"
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_organization_recovery_history_mutation();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'organization_recovery_custodians',
    'organization_recovery_operations',
    'organization_recovery_approvals',
    'organization_governance_commands',
    'organization_authorization_invalidations',
    'organization_recovery_audit'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = current_schema()
        AND tablename = table_name
        AND policyname = 'organization_account_isolation'
    ) THEN
      EXECUTE format('DROP POLICY organization_account_isolation ON %I', table_name);
    END IF;
    EXECUTE format(
      'CREATE POLICY organization_account_isolation ON %I USING (opengeni_private.account_rls_visible(account_id)) WITH CHECK (opengeni_private.account_rls_visible(account_id))',
      table_name
    );
  END LOOP;
END $$;

DO $$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON %I.organization_recovery_custodians, %I.organization_recovery_operations, %I.organization_recovery_approvals TO opengeni_app',
      target_schema, target_schema, target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT ON %I.organization_governance_commands, %I.organization_authorization_invalidations, %I.organization_recovery_audit TO opengeni_app',
      target_schema, target_schema, target_schema
    );
    GRANT EXECUTE ON FUNCTION opengeni_private.reject_organization_recovery_history_mutation()
      TO opengeni_app;
  END IF;
END $$;