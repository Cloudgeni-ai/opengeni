-- Workspace auth + managed billing control plane.
-- Upgrades pre-workspace databases in place: new auth/account/billing tables,
-- account_id/workspace_id scoping on all existing tables (backfilled into a
-- default account/workspace when rows exist), workspace-scoped indexes, and RLS.
-- Every statement is idempotent so the file is safe to re-run.

CREATE TABLE IF NOT EXISTS "auth_users" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "email_verified" boolean NOT NULL DEFAULT false,
  "image" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "auth_users_email_idx" ON "auth_users" (lower("email"));

CREATE TABLE IF NOT EXISTS "auth_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "auth_users"("id") ON DELETE CASCADE,
  "token" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "auth_sessions_token_idx" ON "auth_sessions" ("token");
CREATE INDEX IF NOT EXISTS "auth_sessions_user_id_idx" ON "auth_sessions" ("user_id");

CREATE TABLE IF NOT EXISTS "auth_identities" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "auth_users"("id") ON DELETE CASCADE,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamptz,
  "refresh_token_expires_at" timestamptz,
  "scope" text,
  "password" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "auth_identities_user_id_idx" ON "auth_identities" ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "auth_identities_provider_account_idx" ON "auth_identities" ("provider_id", "account_id");

CREATE TABLE IF NOT EXISTS "auth_verifications" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "auth_verifications_identifier_idx" ON "auth_verifications" ("identifier");

CREATE TABLE IF NOT EXISTS "auth_rate_limits" (
  "id" text PRIMARY KEY NOT NULL,
  "key" text NOT NULL,
  "count" integer NOT NULL,
  "last_request" bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "auth_rate_limits_key_idx" ON "auth_rate_limits" ("key");

CREATE TABLE IF NOT EXISTS "managed_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "external_source" text,
  "external_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "managed_accounts_external_idx" ON "managed_accounts" ("external_source", "external_id");

CREATE TABLE IF NOT EXISTS "workspaces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "slug" text,
  "external_source" text,
  "external_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "workspaces_account_idx" ON "workspaces" ("account_id");
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_account_slug_idx" ON "workspaces" ("account_id", "slug") WHERE "slug" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_external_idx" ON "workspaces" ("external_source", "external_id");

CREATE TABLE IF NOT EXISTS "workspace_memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "subject_id" text NOT NULL,
  "subject_label" text,
  "role" text NOT NULL DEFAULT 'member',
  "permissions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_memberships_subject_workspace_idx" ON "workspace_memberships" ("subject_id", "workspace_id");
CREATE INDEX IF NOT EXISTS "workspace_memberships_subject_idx" ON "workspace_memberships" ("subject_id");
CREATE INDEX IF NOT EXISTS "workspace_memberships_account_idx" ON "workspace_memberships" ("account_id");

CREATE TABLE IF NOT EXISTS "api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "prefix" text NOT NULL,
  "key_hash" text NOT NULL,
  "permissions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "expires_at" timestamptz,
  "revoked_at" timestamptz,
  "last_used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "api_keys_prefix_idx" ON "api_keys" ("prefix");
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_key_hash_idx" ON "api_keys" ("key_hash");
CREATE INDEX IF NOT EXISTS "api_keys_account_idx" ON "api_keys" ("account_id");
CREATE INDEX IF NOT EXISTS "api_keys_workspace_idx" ON "api_keys" ("workspace_id");

CREATE TABLE IF NOT EXISTS "github_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "installation_id" integer NOT NULL,
  "account_login" text,
  "account_type" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "github_installations_workspace_installation_idx" ON "github_installations" ("workspace_id", "installation_id");
CREATE INDEX IF NOT EXISTS "github_installations_installation_idx" ON "github_installations" ("installation_id");
CREATE INDEX IF NOT EXISTS "github_installations_workspace_idx" ON "github_installations" ("workspace_id");

CREATE TABLE IF NOT EXISTS "usage_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "subject_id" text,
  "event_type" text NOT NULL,
  "quantity" bigint NOT NULL,
  "unit" text NOT NULL,
  "source_resource_type" text,
  "source_resource_id" text,
  "idempotency_key" text NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "recorded_at" timestamptz NOT NULL DEFAULT now(),
  "exported_to_billing_at" timestamptz,
  "billing_provider_event_id" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "usage_events_idempotency_idx" ON "usage_events" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "usage_events_workspace_metric_idx" ON "usage_events" ("workspace_id", "event_type", "occurred_at");
CREATE INDEX IF NOT EXISTS "usage_events_account_metric_idx" ON "usage_events" ("account_id", "event_type", "occurred_at");

CREATE TABLE IF NOT EXISTS "credit_ledger_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE SET NULL,
  "type" text NOT NULL,
  "amount_micros" bigint NOT NULL,
  "currency" text NOT NULL DEFAULT 'usd',
  "source_type" text,
  "source_id" text,
  "idempotency_key" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_entries_idempotency_idx" ON "credit_ledger_entries" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "credit_ledger_entries_account_created_idx" ON "credit_ledger_entries" ("account_id", "created_at");

CREATE TABLE IF NOT EXISTS "billing_customers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "provider" text NOT NULL DEFAULT 'stripe',
  "provider_customer_id" text NOT NULL,
  "email" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "billing_customers_account_provider_idx" ON "billing_customers" ("account_id", "provider");
CREATE UNIQUE INDEX IF NOT EXISTS "billing_customers_provider_customer_idx" ON "billing_customers" ("provider", "provider_customer_id");

CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
  "id" text PRIMARY KEY NOT NULL,
  "type" text NOT NULL,
  "livemode" text NOT NULL DEFAULT 'false',
  "payload" jsonb NOT NULL,
  "processed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid REFERENCES "managed_accounts"("id") ON DELETE SET NULL,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE SET NULL,
  "subject_id" text,
  "action" text NOT NULL,
  "target_type" text,
  "target_id" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "audit_events_account_created_idx" ON "audit_events" ("account_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "audit_events_workspace_created_idx" ON "audit_events" ("workspace_id", "occurred_at");

-- Scope all pre-existing tables to an account and workspace. Columns start
-- nullable so existing rows survive; they are backfilled below and then locked
-- down with SET NOT NULL.

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "account_id" uuid REFERENCES "managed_accounts"("id") ON DELETE CASCADE;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "account_id" uuid REFERENCES "managed_accounts"("id") ON DELETE CASCADE;
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "file_uploads" ADD COLUMN IF NOT EXISTS "account_id" uuid REFERENCES "managed_accounts"("id") ON DELETE CASCADE;
ALTER TABLE "file_uploads" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "document_bases" ADD COLUMN IF NOT EXISTS "account_id" uuid REFERENCES "managed_accounts"("id") ON DELETE CASCADE;
ALTER TABLE "document_bases" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "account_id" uuid REFERENCES "managed_accounts"("id") ON DELETE CASCADE;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "document_chunks" ADD COLUMN IF NOT EXISTS "account_id" uuid REFERENCES "managed_accounts"("id") ON DELETE CASCADE;
ALTER TABLE "document_chunks" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "session_turns" ADD COLUMN IF NOT EXISTS "account_id" uuid REFERENCES "managed_accounts"("id") ON DELETE CASCADE;
ALTER TABLE "session_turns" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "session_events" ADD COLUMN IF NOT EXISTS "account_id" uuid REFERENCES "managed_accounts"("id") ON DELETE CASCADE;
ALTER TABLE "session_events" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "agent_run_states" ADD COLUMN IF NOT EXISTS "account_id" uuid REFERENCES "managed_accounts"("id") ON DELETE CASCADE;
ALTER TABLE "agent_run_states" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "account_id" uuid REFERENCES "managed_accounts"("id") ON DELETE CASCADE;
ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "scheduled_task_runs" ADD COLUMN IF NOT EXISTS "account_id" uuid REFERENCES "managed_accounts"("id") ON DELETE CASCADE;
ALTER TABLE "scheduled_task_runs" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;

-- Backfill: rows created before workspaces existed are adopted by a default
-- account/workspace, created on demand and marked with a stable external id so
-- re-runs find it again.
DO $$
DECLARE
  v_account_id uuid;
  v_workspace_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM "sessions" WHERE "workspace_id" IS NULL OR "account_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "files" WHERE "workspace_id" IS NULL OR "account_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "file_uploads" WHERE "workspace_id" IS NULL OR "account_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "document_bases" WHERE "workspace_id" IS NULL OR "account_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "documents" WHERE "workspace_id" IS NULL OR "account_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "document_chunks" WHERE "workspace_id" IS NULL OR "account_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "session_turns" WHERE "workspace_id" IS NULL OR "account_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "session_events" WHERE "workspace_id" IS NULL OR "account_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "agent_run_states" WHERE "workspace_id" IS NULL OR "account_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "scheduled_tasks" WHERE "workspace_id" IS NULL OR "account_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "scheduled_task_runs" WHERE "workspace_id" IS NULL OR "account_id" IS NULL)
  THEN
    SELECT "id" INTO v_account_id
    FROM "managed_accounts"
    WHERE "external_source" = 'opengeni-migration' AND "external_id" = '0001-default-account';
    IF v_account_id IS NULL THEN
      INSERT INTO "managed_accounts" ("name", "external_source", "external_id")
      VALUES ('Default Account', 'opengeni-migration', '0001-default-account')
      RETURNING "id" INTO v_account_id;
    END IF;

    SELECT "id" INTO v_workspace_id
    FROM "workspaces"
    WHERE "external_source" = 'opengeni-migration' AND "external_id" = '0001-default-workspace';
    IF v_workspace_id IS NULL THEN
      INSERT INTO "workspaces" ("account_id", "name", "slug", "external_source", "external_id")
      VALUES (v_account_id, 'Default Workspace', 'default', 'opengeni-migration', '0001-default-workspace')
      RETURNING "id" INTO v_workspace_id;
    END IF;

    UPDATE "sessions" SET "account_id" = v_account_id, "workspace_id" = v_workspace_id WHERE "workspace_id" IS NULL OR "account_id" IS NULL;
    UPDATE "files" SET "account_id" = v_account_id, "workspace_id" = v_workspace_id WHERE "workspace_id" IS NULL OR "account_id" IS NULL;
    UPDATE "file_uploads" SET "account_id" = v_account_id, "workspace_id" = v_workspace_id WHERE "workspace_id" IS NULL OR "account_id" IS NULL;
    UPDATE "document_bases" SET "account_id" = v_account_id, "workspace_id" = v_workspace_id WHERE "workspace_id" IS NULL OR "account_id" IS NULL;
    UPDATE "documents" SET "account_id" = v_account_id, "workspace_id" = v_workspace_id WHERE "workspace_id" IS NULL OR "account_id" IS NULL;
    UPDATE "document_chunks" SET "account_id" = v_account_id, "workspace_id" = v_workspace_id WHERE "workspace_id" IS NULL OR "account_id" IS NULL;
    UPDATE "session_turns" SET "account_id" = v_account_id, "workspace_id" = v_workspace_id WHERE "workspace_id" IS NULL OR "account_id" IS NULL;
    UPDATE "session_events" SET "account_id" = v_account_id, "workspace_id" = v_workspace_id WHERE "workspace_id" IS NULL OR "account_id" IS NULL;
    UPDATE "agent_run_states" SET "account_id" = v_account_id, "workspace_id" = v_workspace_id WHERE "workspace_id" IS NULL OR "account_id" IS NULL;
    UPDATE "scheduled_tasks" SET "account_id" = v_account_id, "workspace_id" = v_workspace_id WHERE "workspace_id" IS NULL OR "account_id" IS NULL;
    UPDATE "scheduled_task_runs" SET "account_id" = v_account_id, "workspace_id" = v_workspace_id WHERE "workspace_id" IS NULL OR "account_id" IS NULL;
  END IF;
END $$;

ALTER TABLE "sessions" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "sessions" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "files" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "files" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "file_uploads" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "file_uploads" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "document_bases" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "document_bases" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "documents" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "documents" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "document_chunks" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "document_chunks" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "session_turns" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "session_turns" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "session_events" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "session_events" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "agent_run_states" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "agent_run_states" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "scheduled_tasks" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "scheduled_tasks" ALTER COLUMN "workspace_id" SET NOT NULL;
ALTER TABLE "scheduled_task_runs" ALTER COLUMN "account_id" SET NOT NULL;
ALTER TABLE "scheduled_task_runs" ALTER COLUMN "workspace_id" SET NOT NULL;

-- session_turns columns are always written explicitly now; drop the legacy
-- placeholder defaults so the schema matches a fresh install.
ALTER TABLE "session_turns" ALTER COLUMN "position" DROP DEFAULT;
ALTER TABLE "session_turns" ALTER COLUMN "prompt" DROP DEFAULT;
ALTER TABLE "session_turns" ALTER COLUMN "model" DROP DEFAULT;
ALTER TABLE "session_turns" ALTER COLUMN "reasoning_effort" DROP DEFAULT;
ALTER TABLE "session_turns" ALTER COLUMN "sandbox_backend" DROP DEFAULT;

-- Replace session-scoped indexes with workspace-scoped equivalents.
DROP INDEX IF EXISTS "documents_base_file_idx";
DROP INDEX IF EXISTS "documents_base_status_idx";
DROP INDEX IF EXISTS "document_chunks_document_index_idx";
DROP INDEX IF EXISTS "document_chunks_base_idx";
DROP INDEX IF EXISTS "session_events_session_sequence_idx";
DROP INDEX IF EXISTS "session_events_client_event_idx";
DROP INDEX IF EXISTS "session_events_producer_idx";
DROP INDEX IF EXISTS "session_events_session_created_idx";
DROP INDEX IF EXISTS "session_turns_queue_idx";
DROP INDEX IF EXISTS "scheduled_tasks_temporal_schedule_id_idx";
DROP INDEX IF EXISTS "scheduled_tasks_status_idx";
DROP INDEX IF EXISTS "scheduled_task_runs_task_created_idx";
DROP INDEX IF EXISTS "scheduled_task_runs_session_idx";

CREATE INDEX IF NOT EXISTS "sessions_workspace_created_idx" ON "sessions" ("workspace_id", "created_at");
CREATE INDEX IF NOT EXISTS "files_workspace_created_idx" ON "files" ("workspace_id", "created_at");
CREATE INDEX IF NOT EXISTS "file_uploads_workspace_idx" ON "file_uploads" ("workspace_id");
CREATE INDEX IF NOT EXISTS "document_bases_workspace_created_idx" ON "document_bases" ("workspace_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "documents_workspace_base_file_idx" ON "documents" ("workspace_id", "base_id", "file_id");
CREATE INDEX IF NOT EXISTS "documents_workspace_base_status_idx" ON "documents" ("workspace_id", "base_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "document_chunks_workspace_document_index_idx" ON "document_chunks" ("workspace_id", "document_id", "chunk_index");
CREATE INDEX IF NOT EXISTS "document_chunks_workspace_base_idx" ON "document_chunks" ("workspace_id", "base_id");
CREATE INDEX IF NOT EXISTS "session_turns_workspace_queue_idx" ON "session_turns" ("workspace_id", "session_id", "status", "position");
CREATE UNIQUE INDEX IF NOT EXISTS "session_events_workspace_session_sequence_idx" ON "session_events" ("workspace_id", "session_id", "sequence");
CREATE UNIQUE INDEX IF NOT EXISTS "session_events_workspace_client_event_idx" ON "session_events" ("workspace_id", "session_id", "client_event_id") WHERE "client_event_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "session_events_workspace_producer_idx" ON "session_events" ("workspace_id", "session_id", "producer_id", "producer_seq") WHERE "producer_id" IS NOT NULL AND "producer_seq" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "session_events_workspace_session_created_idx" ON "session_events" ("workspace_id", "session_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "scheduled_tasks_workspace_temporal_schedule_id_idx" ON "scheduled_tasks" ("workspace_id", "temporal_schedule_id");
CREATE INDEX IF NOT EXISTS "scheduled_tasks_workspace_status_idx" ON "scheduled_tasks" ("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "scheduled_task_runs_workspace_task_created_idx" ON "scheduled_task_runs" ("workspace_id", "task_id", "created_at");
CREATE INDEX IF NOT EXISTS "scheduled_task_runs_workspace_session_idx" ON "scheduled_task_runs" ("workspace_id", "session_id");

CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_id_account_idx" ON "workspaces" ("id", "account_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_memberships_workspace_account_fk') THEN
    ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_workspace_account_fk') THEN
    ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_workspace_account_fk') THEN
    ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'files_workspace_account_fk') THEN
    ALTER TABLE "files" ADD CONSTRAINT "files_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'file_uploads_workspace_account_fk') THEN
    ALTER TABLE "file_uploads" ADD CONSTRAINT "file_uploads_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_bases_workspace_account_fk') THEN
    ALTER TABLE "document_bases" ADD CONSTRAINT "document_bases_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_workspace_account_fk') THEN
    ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_chunks_workspace_account_fk') THEN
    ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_turns_workspace_account_fk') THEN
    ALTER TABLE "session_turns" ADD CONSTRAINT "session_turns_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_events_workspace_account_fk') THEN
    ALTER TABLE "session_events" ADD CONSTRAINT "session_events_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_run_states_workspace_account_fk') THEN
    ALTER TABLE "agent_run_states" ADD CONSTRAINT "agent_run_states_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_tasks_workspace_account_fk') THEN
    ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_task_runs_workspace_account_fk') THEN
    ALTER TABLE "scheduled_task_runs" ADD CONSTRAINT "scheduled_task_runs_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'github_installations_workspace_account_fk') THEN
    ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usage_events_workspace_account_fk') THEN
    ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS opengeni_private;

CREATE OR REPLACE FUNCTION opengeni_private.current_workspace_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('opengeni.workspace_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION opengeni_private.current_account_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('opengeni.account_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION opengeni_private.workspace_rls_visible(account_id uuid, workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT account_id = opengeni_private.current_account_id()
    AND workspace_id = opengeni_private.current_workspace_id();
$$;

CREATE OR REPLACE FUNCTION opengeni_private.account_rls_visible(account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT account_id = opengeni_private.current_account_id();
$$;

CREATE OR REPLACE FUNCTION opengeni_private.optional_workspace_rls_visible(account_id uuid, workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT account_id = opengeni_private.current_account_id()
    AND (
      opengeni_private.current_workspace_id() IS NULL
      OR workspace_id IS NULL
      OR workspace_id = opengeni_private.current_workspace_id()
    );
$$;

CREATE OR REPLACE FUNCTION opengeni_private.current_api_key_hash()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('opengeni.api_key_hash', true), '');
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'sessions',
    'session_events',
    'session_turns',
    'agent_run_states',
    'files',
    'file_uploads',
    'document_bases',
    'documents',
    'document_chunks',
    'scheduled_tasks',
    'scheduled_task_runs',
    'github_installations'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = table_name AND policyname = 'workspace_isolation'
    ) THEN
      EXECUTE format('DROP POLICY workspace_isolation ON %I', table_name);
    END IF;
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON %I USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id))',
      table_name
    );
  END LOOP;
END $$;

ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'api_keys' AND policyname = 'api_keys_account_workspace_or_hash_isolation'
  ) THEN
    DROP POLICY "api_keys_account_workspace_or_hash_isolation" ON "api_keys";
  END IF;
END $$;
CREATE POLICY "api_keys_account_workspace_or_hash_isolation" ON "api_keys"
  USING (
    opengeni_private.optional_workspace_rls_visible(account_id, workspace_id)
    OR key_hash = opengeni_private.current_api_key_hash()
  )
  WITH CHECK (
    opengeni_private.optional_workspace_rls_visible(account_id, workspace_id)
    OR key_hash = opengeni_private.current_api_key_hash()
  );

ALTER TABLE "usage_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "usage_events" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'usage_events' AND policyname = 'usage_events_account_workspace_isolation'
  ) THEN
    DROP POLICY "usage_events_account_workspace_isolation" ON "usage_events";
  END IF;
END $$;
CREATE POLICY "usage_events_account_workspace_isolation" ON "usage_events"
  USING (opengeni_private.optional_workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.optional_workspace_rls_visible(account_id, workspace_id));

ALTER TABLE "credit_ledger_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_ledger_entries" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'credit_ledger_entries' AND policyname = 'credit_ledger_account_workspace_isolation'
  ) THEN
    DROP POLICY "credit_ledger_account_workspace_isolation" ON "credit_ledger_entries";
  END IF;
END $$;
CREATE POLICY "credit_ledger_account_workspace_isolation" ON "credit_ledger_entries"
  USING (opengeni_private.optional_workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.optional_workspace_rls_visible(account_id, workspace_id));

ALTER TABLE "billing_customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_customers" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'billing_customers' AND policyname = 'billing_customers_account_isolation'
  ) THEN
    DROP POLICY "billing_customers_account_isolation" ON "billing_customers";
  END IF;
END $$;
CREATE POLICY "billing_customers_account_isolation" ON "billing_customers"
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));

ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'audit_events' AND policyname = 'audit_events_account_workspace_isolation'
  ) THEN
    DROP POLICY "audit_events_account_workspace_isolation" ON "audit_events";
  END IF;
END $$;
CREATE POLICY "audit_events_account_workspace_isolation" ON "audit_events"
  USING (
    account_id IS NULL
    OR opengeni_private.optional_workspace_rls_visible(account_id, workspace_id)
  )
  WITH CHECK (
    account_id IS NULL
    OR opengeni_private.optional_workspace_rls_visible(account_id, workspace_id)
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT USAGE ON SCHEMA public TO opengeni_app;
    GRANT USAGE ON SCHEMA opengeni_private TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO opengeni_app;
  END IF;
END $$;
