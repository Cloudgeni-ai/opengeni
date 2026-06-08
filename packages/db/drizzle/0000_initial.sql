CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

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

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS "sessions_workspace_created_idx" ON "sessions" ("workspace_id", "created_at");

CREATE TABLE IF NOT EXISTS "files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS "files_workspace_created_idx" ON "files" ("workspace_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "files_object_key_idx" ON "files" ("object_key");
CREATE INDEX IF NOT EXISTS "files_status_idx" ON "files" ("status");

CREATE TABLE IF NOT EXISTS "file_uploads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "file_id" uuid NOT NULL REFERENCES "files"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'pending',
  "expires_at" timestamptz NOT NULL,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "file_uploads_workspace_idx" ON "file_uploads" ("workspace_id");
CREATE INDEX IF NOT EXISTS "file_uploads_file_id_idx" ON "file_uploads" ("file_id");
CREATE INDEX IF NOT EXISTS "file_uploads_status_idx" ON "file_uploads" ("status");

CREATE TABLE IF NOT EXISTS "document_bases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "document_bases_workspace_created_idx" ON "document_bases" ("workspace_id", "created_at");

CREATE TABLE IF NOT EXISTS "documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
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
CREATE UNIQUE INDEX IF NOT EXISTS "documents_workspace_base_file_idx" ON "documents" ("workspace_id", "base_id", "file_id");
CREATE INDEX IF NOT EXISTS "documents_workspace_base_status_idx" ON "documents" ("workspace_id", "base_id", "status");

CREATE TABLE IF NOT EXISTS "document_chunks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
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
CREATE UNIQUE INDEX IF NOT EXISTS "document_chunks_workspace_document_index_idx" ON "document_chunks" ("workspace_id", "document_id", "chunk_index");
CREATE INDEX IF NOT EXISTS "document_chunks_workspace_base_idx" ON "document_chunks" ("workspace_id", "base_id");

CREATE TABLE IF NOT EXISTS "session_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "trigger_event_id" uuid NOT NULL,
  "temporal_workflow_id" text NOT NULL,
  "status" text NOT NULL,
  "source" text NOT NULL DEFAULT 'user',
  "position" integer NOT NULL,
  "prompt" text NOT NULL,
  "resources" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "tools" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "model" text NOT NULL,
  "reasoning_effort" text NOT NULL,
  "sandbox_backend" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "session_turns_workspace_queue_idx" ON "session_turns" ("workspace_id", "session_id", "status", "position");

CREATE TABLE IF NOT EXISTS "session_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
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
CREATE UNIQUE INDEX IF NOT EXISTS "session_events_workspace_session_sequence_idx" ON "session_events" ("workspace_id", "session_id", "sequence");
CREATE UNIQUE INDEX IF NOT EXISTS "session_events_workspace_client_event_idx" ON "session_events" ("workspace_id", "session_id", "client_event_id") WHERE "client_event_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "session_events_workspace_producer_idx" ON "session_events" ("workspace_id", "session_id", "producer_id", "producer_seq") WHERE "producer_id" IS NOT NULL AND "producer_seq" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "session_events_workspace_session_created_idx" ON "session_events" ("workspace_id", "session_id", "created_at");

CREATE TABLE IF NOT EXISTS "agent_run_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "turn_id" uuid REFERENCES "session_turns"("id") ON DELETE SET NULL,
  "state_version" integer NOT NULL,
  "serialized_run_state" text NOT NULL,
  "pending_approvals" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "scheduled_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "schedule" jsonb NOT NULL,
  "temporal_schedule_id" text NOT NULL,
  "run_mode" text NOT NULL DEFAULT 'new_session_per_run',
  "overlap_policy" text NOT NULL DEFAULT 'allow_concurrent',
  "agent_config" jsonb NOT NULL,
  "reusable_session_id" uuid REFERENCES "sessions"("id") ON DELETE SET NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "scheduled_tasks_workspace_temporal_schedule_id_idx" ON "scheduled_tasks" ("workspace_id", "temporal_schedule_id");
CREATE INDEX IF NOT EXISTS "scheduled_tasks_workspace_status_idx" ON "scheduled_tasks" ("workspace_id", "status");

CREATE TABLE IF NOT EXISTS "scheduled_task_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "task_id" uuid NOT NULL REFERENCES "scheduled_tasks"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'queued',
  "trigger_type" text NOT NULL,
  "scheduled_at" timestamptz,
  "fired_at" timestamptz NOT NULL DEFAULT now(),
  "session_id" uuid REFERENCES "sessions"("id") ON DELETE SET NULL,
  "trigger_event_id" uuid,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "scheduled_task_runs_workspace_task_created_idx" ON "scheduled_task_runs" ("workspace_id", "task_id", "created_at");
CREATE INDEX IF NOT EXISTS "scheduled_task_runs_workspace_session_idx" ON "scheduled_task_runs" ("workspace_id", "session_id");

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
