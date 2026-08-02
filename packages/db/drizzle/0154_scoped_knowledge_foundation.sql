-- deployment-mode: rolling
-- Additive provider-neutral scoped-knowledge foundation. This migration creates
-- no connector, route, SDK/MCP/UI surface, prompt composition, policy head, or
-- active preference/memory write path.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE SEQUENCE "knowledge_claim_review_revision_seq" AS bigint;

CREATE OR REPLACE FUNCTION opengeni_private.scoped_knowledge_scope_valid(
  row_scope text,
  row_workspace_id uuid,
  row_subject_id text
) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT
    (row_scope = 'organization' AND row_workspace_id IS NULL AND row_subject_id IS NULL)
    OR (row_scope = 'workspace' AND row_workspace_id IS NOT NULL AND row_subject_id IS NULL)
    OR (
      row_scope = 'personal'
      AND nullif(btrim(row_subject_id), '') IS NOT NULL
    );
$$;

CREATE OR REPLACE FUNCTION opengeni_private.scoped_knowledge_scope_key(
  row_scope text,
  row_workspace_id uuid,
  row_subject_id text
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT row_scope || ':' || coalesce(row_workspace_id::text, '-') || ':' ||
    coalesce(row_subject_id, '-');
$$;

CREATE OR REPLACE FUNCTION opengeni_private.scoped_knowledge_scope_visible(
  row_account_id uuid,
  row_scope text,
  row_workspace_id uuid,
  row_subject_id text
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT row_account_id = opengeni_private.current_account_id()
    AND (
      row_scope = 'organization'
      OR (
        row_scope = 'workspace'
        AND row_workspace_id = opengeni_private.current_workspace_id()
      )
      OR (
        row_scope = 'personal'
        AND row_subject_id = opengeni_private.current_subject_id()
        AND (
          row_workspace_id IS NULL
          OR row_workspace_id = opengeni_private.current_workspace_id()
        )
      )
    );
$$;

CREATE OR REPLACE FUNCTION opengeni_private.scoped_knowledge_actor_valid(
  row_actor_kind text,
  row_actor_subject_id text,
  row_initiating_human_subject_id text
) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT length(btrim(row_actor_subject_id)) BETWEEN 1 AND 1024
    AND (
      (
        row_actor_kind = 'human'
        AND row_initiating_human_subject_id = row_actor_subject_id
      )
      OR (
        row_actor_kind = 'service'
        AND (
          row_initiating_human_subject_id IS NULL
          OR length(btrim(row_initiating_human_subject_id)) BETWEEN 1 AND 1024
        )
      )
    );
$$;

CREATE OR REPLACE FUNCTION opengeni_private.scoped_knowledge_actor_authorized(
  row_actor_kind text,
  row_actor_subject_id text,
  row_initiating_human_subject_id text
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT opengeni_private.scoped_knowledge_actor_valid(
      row_actor_kind, row_actor_subject_id, row_initiating_human_subject_id
    )
    AND (
      (
        row_actor_kind = 'human'
        AND row_actor_subject_id = opengeni_private.current_subject_id()
        AND row_initiating_human_subject_id = opengeni_private.current_subject_id()
      )
      OR (
        row_actor_kind = 'service'
        AND row_initiating_human_subject_id
          IS NOT DISTINCT FROM opengeni_private.current_subject_id()
      )
    );
$$;

CREATE TABLE "knowledge_providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "scope_kind" text NOT NULL,
  "scope_workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "scope_subject_id" text,
  "scope_key" text NOT NULL,
  "provider_key" text NOT NULL,
  "external_tenant_id" text NOT NULL,
  "lifecycle_state" text NOT NULL DEFAULT 'active',
  "lifecycle_generation" bigint NOT NULL DEFAULT 1,
  "operation_id" text NOT NULL,
  "input_hash" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "initiating_human_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_providers_scope_chk" CHECK (
    opengeni_private.scoped_knowledge_scope_valid(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
    AND "scope_key" = opengeni_private.scoped_knowledge_scope_key(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
  ),
  CONSTRAINT "knowledge_providers_provider_key_chk" CHECK (
    "provider_key" = lower(btrim("provider_key"))
    AND length("provider_key") BETWEEN 1 AND 96
    AND "provider_key" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'
    AND "provider_key" !~ '--'
  ),
  CONSTRAINT "knowledge_providers_external_identity_chk" CHECK (
    length(btrim("external_tenant_id")) BETWEEN 1 AND 1024
  ),
  CONSTRAINT "knowledge_providers_lifecycle_chk" CHECK (
    "lifecycle_state" IN ('active', 'deleted', 'revoked')
    AND "lifecycle_generation" > 0
  ),
  CONSTRAINT "knowledge_providers_idempotency_chk" CHECK (
    length(btrim("operation_id")) BETWEEN 1 AND 256
    AND "input_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "knowledge_providers_actor_chk" CHECK (
    opengeni_private.scoped_knowledge_actor_valid(
      "actor_kind", "actor_subject_id", "initiating_human_subject_id"
    )
  ),
  CONSTRAINT "knowledge_providers_external_identity_uq"
    UNIQUE ("account_id", "provider_key", "external_tenant_id"),
  CONSTRAINT "knowledge_providers_operation_uq" UNIQUE ("account_id", "operation_id"),
  CONSTRAINT "knowledge_providers_scope_identity_uq"
    UNIQUE ("account_id", "id", "scope_key")
);

CREATE INDEX "knowledge_providers_scope_lifecycle_idx"
  ON "knowledge_providers" ("account_id", "scope_key", "lifecycle_state");

CREATE TABLE "knowledge_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "scope_kind" text NOT NULL,
  "scope_workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "scope_subject_id" text,
  "scope_key" text NOT NULL,
  "provider_id" uuid NOT NULL,
  "external_source_id" text NOT NULL,
  "source_kind" text NOT NULL,
  "source_uri" text,
  "current_acl_generation" bigint,
  "sync_generation" bigint NOT NULL DEFAULT 0,
  "sync_cursor" text,
  "lifecycle_state" text NOT NULL DEFAULT 'active',
  "lifecycle_generation" bigint NOT NULL DEFAULT 1,
  "operation_id" text NOT NULL,
  "input_hash" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "initiating_human_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_sources_provider_fk"
    FOREIGN KEY ("account_id", "provider_id", "scope_key")
    REFERENCES "knowledge_providers"("account_id", "id", "scope_key") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_sources_scope_chk" CHECK (
    opengeni_private.scoped_knowledge_scope_valid(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
    AND "scope_key" = opengeni_private.scoped_knowledge_scope_key(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
  ),
  CONSTRAINT "knowledge_sources_identity_chk" CHECK (
    length(btrim("external_source_id")) BETWEEN 1 AND 1024
    AND length(btrim("source_kind")) BETWEEN 1 AND 96
    AND ("source_uri" IS NULL OR length("source_uri") BETWEEN 1 AND 4096)
  ),
  CONSTRAINT "knowledge_sources_generations_chk" CHECK (
    ("current_acl_generation" IS NULL OR "current_acl_generation" > 0)
    AND "sync_generation" >= 0
    AND "lifecycle_generation" > 0
    AND "lifecycle_state" IN ('active', 'deleted', 'revoked')
  ),
  CONSTRAINT "knowledge_sources_idempotency_chk" CHECK (
    length(btrim("operation_id")) BETWEEN 1 AND 256
    AND "input_hash" ~ '^[0-9a-f]{64}$'
    AND ("sync_cursor" IS NULL OR length("sync_cursor") <= 4096)
  ),
  CONSTRAINT "knowledge_sources_actor_chk" CHECK (
    opengeni_private.scoped_knowledge_actor_valid(
      "actor_kind", "actor_subject_id", "initiating_human_subject_id"
    )
  ),
  CONSTRAINT "knowledge_sources_external_identity_uq"
    UNIQUE ("provider_id", "external_source_id"),
  CONSTRAINT "knowledge_sources_operation_uq" UNIQUE ("account_id", "operation_id"),
  CONSTRAINT "knowledge_sources_scope_identity_uq"
    UNIQUE ("account_id", "id", "scope_key"),
  CONSTRAINT "knowledge_sources_current_acl_identity_uq"
    UNIQUE ("account_id", "id", "current_acl_generation")
);

CREATE INDEX "knowledge_sources_provider_idx"
  ON "knowledge_sources" ("provider_id", "external_source_id");

CREATE TABLE "knowledge_source_acl_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "scope_kind" text NOT NULL,
  "scope_workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "scope_subject_id" text,
  "scope_key" text NOT NULL,
  "source_id" uuid NOT NULL,
  "source_scope_key" text NOT NULL,
  "generation" bigint NOT NULL,
  "acl_version" text,
  "acl_hash" text NOT NULL,
  "agent_access" boolean NOT NULL DEFAULT true,
  "operation_id" text NOT NULL,
  "input_hash" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "initiating_human_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_source_acl_versions_source_fk"
    FOREIGN KEY ("account_id", "source_id", "source_scope_key")
    REFERENCES "knowledge_sources"("account_id", "id", "scope_key") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_source_acl_versions_scope_chk" CHECK (
    opengeni_private.scoped_knowledge_scope_valid(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
    AND "scope_key" = opengeni_private.scoped_knowledge_scope_key(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
  ),
  CONSTRAINT "knowledge_source_acl_versions_generation_chk" CHECK ("generation" > 0),
  CONSTRAINT "knowledge_source_acl_versions_hash_chk" CHECK (
    "acl_hash" ~ '^[0-9a-f]{64}$'
    AND "input_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "knowledge_source_acl_versions_bounds_chk" CHECK (
    ("acl_version" IS NULL OR length("acl_version") BETWEEN 1 AND 512)
    AND length(btrim("operation_id")) BETWEEN 1 AND 256
  ),
  CONSTRAINT "knowledge_source_acl_versions_actor_chk" CHECK (
    opengeni_private.scoped_knowledge_actor_valid(
      "actor_kind", "actor_subject_id", "initiating_human_subject_id"
    )
  ),
  CONSTRAINT "knowledge_source_acl_versions_source_generation_uq"
    UNIQUE ("account_id", "source_id", "generation"),
  CONSTRAINT "knowledge_source_acl_versions_source_operation_uq"
    UNIQUE ("source_id", "operation_id")
);

CREATE INDEX "knowledge_source_acl_versions_source_timeline_idx"
  ON "knowledge_source_acl_versions" ("source_id", "generation" DESC);

ALTER TABLE "knowledge_sources"
  ADD CONSTRAINT "knowledge_sources_current_acl_fk"
  FOREIGN KEY ("account_id", "id", "current_acl_generation")
  REFERENCES "knowledge_source_acl_versions"("account_id", "source_id", "generation")
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "knowledge_sync_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "scope_kind" text NOT NULL,
  "scope_workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "scope_subject_id" text,
  "scope_key" text NOT NULL,
  "source_id" uuid NOT NULL,
  "input_sync_generation" bigint NOT NULL,
  "input_lifecycle_generation" bigint NOT NULL,
  "input_cursor" text,
  "input_hash" text NOT NULL,
  "operation_id" text NOT NULL,
  "state" text NOT NULL DEFAULT 'started',
  "output_cursor" text,
  "watermark" timestamptz,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "error_code" text,
  "completion_hash" text,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "initiating_human_subject_id" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  CONSTRAINT "knowledge_sync_runs_source_fk"
    FOREIGN KEY ("account_id", "source_id", "scope_key")
    REFERENCES "knowledge_sources"("account_id", "id", "scope_key") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_sync_runs_scope_chk" CHECK (
    opengeni_private.scoped_knowledge_scope_valid(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
    AND "scope_key" = opengeni_private.scoped_knowledge_scope_key(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
  ),
  CONSTRAINT "knowledge_sync_runs_input_chk" CHECK (
    "input_sync_generation" >= 0
    AND "input_lifecycle_generation" > 0
    AND "input_hash" ~ '^[0-9a-f]{64}$'
    AND length(btrim("operation_id")) BETWEEN 1 AND 256
    AND ("input_cursor" IS NULL OR length("input_cursor") <= 4096)
  ),
  CONSTRAINT "knowledge_sync_runs_state_chk" CHECK (
    (
      "state" = 'started'
      AND "completed_at" IS NULL
      AND "completion_hash" IS NULL
      AND "output_cursor" IS NULL
      AND "error_code" IS NULL
    ) OR (
      "state" = 'succeeded'
      AND "completed_at" IS NOT NULL
      AND "completion_hash" ~ '^[0-9a-f]{64}$'
      AND "error_code" IS NULL
    ) OR (
      "state" = 'failed'
      AND "completed_at" IS NOT NULL
      AND "completion_hash" ~ '^[0-9a-f]{64}$'
      AND length(btrim("error_code")) BETWEEN 1 AND 128
      AND "output_cursor" IS NULL
    )
  ),
  CONSTRAINT "knowledge_sync_runs_metadata_chk" CHECK (
    jsonb_typeof("metadata") = 'object'
    AND octet_length(convert_to("metadata"::text, 'UTF8')) <= 16384
    AND ("output_cursor" IS NULL OR length("output_cursor") <= 4096)
  ),
  CONSTRAINT "knowledge_sync_runs_actor_chk" CHECK (
    opengeni_private.scoped_knowledge_actor_valid(
      "actor_kind", "actor_subject_id", "initiating_human_subject_id"
    )
  ),
  CONSTRAINT "knowledge_sync_runs_source_operation_uq" UNIQUE ("source_id", "operation_id")
);

CREATE INDEX "knowledge_sync_runs_source_state_idx"
  ON "knowledge_sync_runs" ("source_id", "state", "started_at" DESC);

CREATE TABLE "knowledge_source_objects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "scope_kind" text NOT NULL,
  "scope_workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "scope_subject_id" text,
  "scope_key" text NOT NULL,
  "source_id" uuid NOT NULL,
  "external_object_id" text NOT NULL,
  "document_id" uuid,
  "lifecycle_state" text NOT NULL DEFAULT 'active',
  "lifecycle_generation" bigint NOT NULL DEFAULT 1,
  "version_generation" bigint NOT NULL DEFAULT 0,
  "current_version_id" uuid,
  "operation_id" text NOT NULL,
  "input_hash" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "initiating_human_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_source_objects_source_fk"
    FOREIGN KEY ("account_id", "source_id", "scope_key")
    REFERENCES "knowledge_sources"("account_id", "id", "scope_key") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_source_objects_scope_chk" CHECK (
    opengeni_private.scoped_knowledge_scope_valid(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
    AND "scope_key" = opengeni_private.scoped_knowledge_scope_key(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
  ),
  CONSTRAINT "knowledge_source_objects_identity_chk" CHECK (
    length(btrim("external_object_id")) BETWEEN 1 AND 1024
  ),
  CONSTRAINT "knowledge_source_objects_generation_chk" CHECK (
    "lifecycle_state" IN ('active', 'deleted', 'revoked')
    AND "lifecycle_generation" > 0
    AND "version_generation" >= 0
    AND (("current_version_id" IS NULL) = ("version_generation" = 0))
  ),
  CONSTRAINT "knowledge_source_objects_idempotency_chk" CHECK (
    length(btrim("operation_id")) BETWEEN 1 AND 256
    AND "input_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "knowledge_source_objects_actor_chk" CHECK (
    opengeni_private.scoped_knowledge_actor_valid(
      "actor_kind", "actor_subject_id", "initiating_human_subject_id"
    )
  ),
  CONSTRAINT "knowledge_source_objects_external_identity_uq"
    UNIQUE ("source_id", "external_object_id"),
  CONSTRAINT "knowledge_source_objects_source_operation_uq"
    UNIQUE ("source_id", "operation_id"),
  CONSTRAINT "knowledge_source_objects_scope_identity_uq"
    UNIQUE ("account_id", "id", "scope_key"),
  CONSTRAINT "knowledge_source_objects_source_identity_uq"
    UNIQUE ("account_id", "id", "source_id", "scope_key"),
  CONSTRAINT "knowledge_source_objects_current_version_identity_uq"
    UNIQUE ("account_id", "id", "current_version_id")
);

CREATE TABLE "knowledge_document_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "scope_kind" text NOT NULL,
  "scope_workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "scope_subject_id" text,
  "scope_key" text NOT NULL,
  "source_id" uuid NOT NULL,
  "object_id" uuid NOT NULL,
  "version_generation" bigint NOT NULL,
  "external_version_id" text NOT NULL,
  "content_sha256" text NOT NULL,
  "ingestion_key" text NOT NULL,
  "source_cursor" text,
  "source_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "source_created_at" timestamptz,
  "source_updated_at" timestamptz,
  "observed_at" timestamptz NOT NULL DEFAULT now(),
  "acl_version_id" uuid NOT NULL,
  "acl_generation" bigint NOT NULL,
  "document_id" uuid,
  "file_id" uuid,
  "location_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "operation_id" text NOT NULL,
  "input_hash" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "initiating_human_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_document_versions_source_fk"
    FOREIGN KEY ("account_id", "source_id", "scope_key")
    REFERENCES "knowledge_sources"("account_id", "id", "scope_key") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_document_versions_object_fk"
    FOREIGN KEY ("account_id", "object_id", "source_id", "scope_key")
    REFERENCES "knowledge_source_objects"("account_id", "id", "source_id", "scope_key")
    ON DELETE RESTRICT,
  CONSTRAINT "knowledge_document_versions_acl_fk"
    FOREIGN KEY ("account_id", "source_id", "acl_generation")
    REFERENCES "knowledge_source_acl_versions"("account_id", "source_id", "generation")
    ON DELETE RESTRICT,
  CONSTRAINT "knowledge_document_versions_scope_chk" CHECK (
    opengeni_private.scoped_knowledge_scope_valid(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
    AND "scope_key" = opengeni_private.scoped_knowledge_scope_key(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
  ),
  CONSTRAINT "knowledge_document_versions_identity_chk" CHECK (
    "version_generation" > 0
    AND length(btrim("external_version_id")) BETWEEN 1 AND 1024
    AND length(btrim("ingestion_key")) BETWEEN 1 AND 512
    AND "content_sha256" ~ '^[0-9a-f]{64}$'
    AND "acl_generation" > 0
    AND ("source_cursor" IS NULL OR length("source_cursor") <= 4096)
  ),
  CONSTRAINT "knowledge_document_versions_metadata_chk" CHECK (
    jsonb_typeof("source_metadata") = 'object'
    AND jsonb_typeof("location_metadata") = 'object'
    AND octet_length(convert_to("source_metadata"::text, 'UTF8')) <= 16384
    AND octet_length(convert_to("location_metadata"::text, 'UTF8')) <= 16384
  ),
  CONSTRAINT "knowledge_document_versions_idempotency_chk" CHECK (
    length(btrim("operation_id")) BETWEEN 1 AND 256
    AND "input_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "knowledge_document_versions_actor_chk" CHECK (
    opengeni_private.scoped_knowledge_actor_valid(
      "actor_kind", "actor_subject_id", "initiating_human_subject_id"
    )
  ),
  CONSTRAINT "knowledge_document_versions_object_generation_uq"
    UNIQUE ("account_id", "object_id", "version_generation"),
  CONSTRAINT "knowledge_document_versions_object_external_version_uq"
    UNIQUE ("object_id", "external_version_id"),
  CONSTRAINT "knowledge_document_versions_object_ingestion_uq"
    UNIQUE ("object_id", "ingestion_key"),
  CONSTRAINT "knowledge_document_versions_object_operation_uq"
    UNIQUE ("object_id", "operation_id"),
  CONSTRAINT "knowledge_document_versions_object_identity_uq"
    UNIQUE ("account_id", "object_id", "id"),
  CONSTRAINT "knowledge_document_versions_scope_identity_uq"
    UNIQUE ("account_id", "id", "scope_key")
);

ALTER TABLE "knowledge_source_objects"
  ADD CONSTRAINT "knowledge_source_objects_current_version_fk"
  FOREIGN KEY ("account_id", "id", "current_version_id")
  REFERENCES "knowledge_document_versions"("account_id", "object_id", "id")
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "knowledge_lifecycle_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "scope_kind" text NOT NULL,
  "scope_workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "scope_subject_id" text,
  "scope_key" text NOT NULL,
  "target_kind" text NOT NULL,
  "provider_id" uuid,
  "source_id" uuid,
  "object_id" uuid,
  "event_type" text NOT NULL,
  "old_state" text NOT NULL,
  "new_state" text NOT NULL,
  "old_generation" bigint NOT NULL,
  "new_generation" bigint NOT NULL,
  "operation_id" text NOT NULL,
  "input_hash" text NOT NULL,
  "reason_code" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "initiating_human_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_lifecycle_events_provider_fk"
    FOREIGN KEY ("account_id", "provider_id", "scope_key")
    REFERENCES "knowledge_providers"("account_id", "id", "scope_key") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_lifecycle_events_source_fk"
    FOREIGN KEY ("account_id", "source_id", "scope_key")
    REFERENCES "knowledge_sources"("account_id", "id", "scope_key") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_lifecycle_events_object_fk"
    FOREIGN KEY ("account_id", "object_id", "scope_key")
    REFERENCES "knowledge_source_objects"("account_id", "id", "scope_key") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_lifecycle_events_scope_chk" CHECK (
    opengeni_private.scoped_knowledge_scope_valid(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
    AND "scope_key" = opengeni_private.scoped_knowledge_scope_key(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
  ),
  CONSTRAINT "knowledge_lifecycle_events_target_chk" CHECK (
    ("target_kind" = 'provider' AND "provider_id" IS NOT NULL
      AND "source_id" IS NULL AND "object_id" IS NULL)
    OR ("target_kind" = 'source' AND "provider_id" IS NULL
      AND "source_id" IS NOT NULL AND "object_id" IS NULL)
    OR ("target_kind" = 'object' AND "provider_id" IS NULL
      AND "source_id" IS NULL AND "object_id" IS NOT NULL)
  ),
  CONSTRAINT "knowledge_lifecycle_events_transition_chk" CHECK (
    "event_type" IN (
      'deleted', 'revoked', 'restored', 'acl_changed',
      'sync_succeeded', 'sync_failed', 'object_version_added'
    )
    AND "old_state" IN ('active', 'deleted', 'revoked')
    AND "new_state" IN ('active', 'deleted', 'revoked')
    AND "old_generation" > 0
    AND "new_generation" >= "old_generation"
    AND (
      ("event_type" IN ('deleted', 'revoked', 'restored')
        AND "new_generation" = "old_generation" + 1)
      OR ("event_type" NOT IN ('deleted', 'revoked', 'restored')
        AND "new_generation" = "old_generation"
        AND "new_state" = "old_state")
    )
  ),
  CONSTRAINT "knowledge_lifecycle_events_audit_chk" CHECK (
    length(btrim("operation_id")) BETWEEN 1 AND 256
    AND "input_hash" ~ '^[0-9a-f]{64}$'
    AND length(btrim("reason_code")) BETWEEN 1 AND 128
    AND opengeni_private.scoped_knowledge_actor_valid(
      "actor_kind", "actor_subject_id", "initiating_human_subject_id"
    )
  )
);

CREATE UNIQUE INDEX "knowledge_lifecycle_events_target_operation_uq"
  ON "knowledge_lifecycle_events" (
    "account_id", "target_kind", "provider_id", "source_id", "object_id", "operation_id"
  ) NULLS NOT DISTINCT;
CREATE INDEX "knowledge_lifecycle_events_target_timeline_idx"
  ON "knowledge_lifecycle_events" (
    "target_kind", "provider_id", "source_id", "object_id", "created_at" DESC
  );

CREATE TABLE "knowledge_entities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "scope_kind" text NOT NULL,
  "scope_workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "scope_subject_id" text,
  "scope_key" text NOT NULL,
  "entity_type" text NOT NULL,
  "normalized_key" text NOT NULL,
  "display_name" text NOT NULL,
  "operation_id" text NOT NULL,
  "input_hash" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "initiating_human_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_entities_scope_chk" CHECK (
    opengeni_private.scoped_knowledge_scope_valid(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
    AND "scope_key" = opengeni_private.scoped_knowledge_scope_key(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
  ),
  CONSTRAINT "knowledge_entities_key_chk" CHECK (
    "entity_type" = lower(btrim("entity_type"))
    AND length("entity_type") BETWEEN 1 AND 96
    AND "entity_type" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'
    AND "normalized_key" = lower(btrim("normalized_key"))
    AND length("normalized_key") BETWEEN 1 AND 512
    AND length(btrim("display_name")) BETWEEN 1 AND 512
  ),
  CONSTRAINT "knowledge_entities_audit_chk" CHECK (
    length(btrim("operation_id")) BETWEEN 1 AND 256
    AND "input_hash" ~ '^[0-9a-f]{64}$'
    AND opengeni_private.scoped_knowledge_actor_valid(
      "actor_kind", "actor_subject_id", "initiating_human_subject_id"
    )
  ),
  CONSTRAINT "knowledge_entities_natural_identity_uq"
    UNIQUE ("account_id", "scope_key", "entity_type", "normalized_key"),
  CONSTRAINT "knowledge_entities_operation_uq" UNIQUE ("account_id", "operation_id"),
  CONSTRAINT "knowledge_entities_scope_identity_uq"
    UNIQUE ("account_id", "id", "scope_key"),
  CONSTRAINT "knowledge_entities_scope_type_identity_uq"
    UNIQUE ("account_id", "id", "scope_key", "entity_type")
);

CREATE TABLE "knowledge_entity_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "scope_kind" text NOT NULL,
  "scope_workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "scope_subject_id" text,
  "scope_key" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "entity_type" text NOT NULL,
  "alias" text NOT NULL,
  "normalized_alias" text NOT NULL,
  "operation_id" text NOT NULL,
  "input_hash" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "initiating_human_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_entity_aliases_entity_fk"
    FOREIGN KEY ("account_id", "entity_id", "scope_key", "entity_type")
    REFERENCES "knowledge_entities"("account_id", "id", "scope_key", "entity_type")
    ON DELETE RESTRICT,
  CONSTRAINT "knowledge_entity_aliases_scope_chk" CHECK (
    opengeni_private.scoped_knowledge_scope_valid(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
    AND "scope_key" = opengeni_private.scoped_knowledge_scope_key(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
  ),
  CONSTRAINT "knowledge_entity_aliases_alias_chk" CHECK (
    length(btrim("alias")) BETWEEN 1 AND 512
    AND "normalized_alias" = lower(btrim("normalized_alias"))
    AND length("normalized_alias") BETWEEN 1 AND 512
  ),
  CONSTRAINT "knowledge_entity_aliases_audit_chk" CHECK (
    length(btrim("operation_id")) BETWEEN 1 AND 256
    AND "input_hash" ~ '^[0-9a-f]{64}$'
    AND opengeni_private.scoped_knowledge_actor_valid(
      "actor_kind", "actor_subject_id", "initiating_human_subject_id"
    )
  ),
  CONSTRAINT "knowledge_entity_aliases_natural_identity_uq"
    UNIQUE ("account_id", "scope_key", "entity_type", "normalized_alias"),
  CONSTRAINT "knowledge_entity_aliases_operation_uq" UNIQUE ("account_id", "operation_id")
);

CREATE INDEX "knowledge_entity_aliases_entity_idx"
  ON "knowledge_entity_aliases" ("entity_id", "created_at");

CREATE TABLE "knowledge_facts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "scope_kind" text NOT NULL,
  "scope_workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "scope_subject_id" text,
  "scope_key" text NOT NULL,
  "subject_entity_id" uuid NOT NULL,
  "predicate_key" text NOT NULL,
  "object_kind" text NOT NULL,
  "object_entity_id" uuid,
  "object_value" jsonb,
  "object_hash" text NOT NULL,
  "operation_id" text NOT NULL,
  "input_hash" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "initiating_human_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_facts_subject_fk"
    FOREIGN KEY ("account_id", "subject_entity_id", "scope_key")
    REFERENCES "knowledge_entities"("account_id", "id", "scope_key") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_facts_object_entity_fk"
    FOREIGN KEY ("account_id", "object_entity_id", "scope_key")
    REFERENCES "knowledge_entities"("account_id", "id", "scope_key") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_facts_scope_chk" CHECK (
    opengeni_private.scoped_knowledge_scope_valid(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
    AND "scope_key" = opengeni_private.scoped_knowledge_scope_key(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
  ),
  CONSTRAINT "knowledge_facts_predicate_chk" CHECK (
    "predicate_key" = lower(btrim("predicate_key"))
    AND length("predicate_key") BETWEEN 1 AND 128
    AND "predicate_key" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'
  ),
  CONSTRAINT "knowledge_facts_object_shape_chk" CHECK (
    ("object_kind" = 'entity' AND "object_entity_id" IS NOT NULL AND "object_value" IS NULL)
    OR ("object_kind" IN ('text', 'number', 'boolean', 'json', 'timestamp')
      AND "object_entity_id" IS NULL AND "object_value" IS NOT NULL)
  ),
  CONSTRAINT "knowledge_facts_hash_chk" CHECK (
    "object_hash" ~ '^[0-9a-f]{64}$'
    AND "input_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "knowledge_facts_audit_chk" CHECK (
    length(btrim("operation_id")) BETWEEN 1 AND 256
    AND opengeni_private.scoped_knowledge_actor_valid(
      "actor_kind", "actor_subject_id", "initiating_human_subject_id"
    )
  ),
  CONSTRAINT "knowledge_facts_natural_identity_uq"
    UNIQUE ("account_id", "scope_key", "subject_entity_id", "predicate_key", "object_hash"),
  CONSTRAINT "knowledge_facts_operation_uq" UNIQUE ("account_id", "operation_id"),
  CONSTRAINT "knowledge_facts_scope_identity_uq"
    UNIQUE ("account_id", "id", "scope_key")
);

CREATE TABLE "knowledge_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "scope_kind" text NOT NULL,
  "scope_workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "scope_subject_id" text,
  "scope_key" text NOT NULL,
  "fact_id" uuid NOT NULL,
  "origin" text NOT NULL,
  "confidence_bps" integer NOT NULL,
  "effective_at" timestamptz NOT NULL,
  "expires_at" timestamptz,
  "extraction_method" text NOT NULL,
  "extraction_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "model_provider" text,
  "model_name" text,
  "model_version" text,
  "operation_id" text NOT NULL,
  "input_hash" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "initiating_human_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_claims_fact_fk"
    FOREIGN KEY ("account_id", "fact_id", "scope_key")
    REFERENCES "knowledge_facts"("account_id", "id", "scope_key") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_claims_scope_chk" CHECK (
    opengeni_private.scoped_knowledge_scope_valid(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
    AND "scope_key" = opengeni_private.scoped_knowledge_scope_key(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
  ),
  CONSTRAINT "knowledge_claims_assertion_chk" CHECK (
    "origin" IN ('explicit', 'inferred')
    AND "confidence_bps" BETWEEN 0 AND 10000
    AND ("expires_at" IS NULL OR "effective_at" < "expires_at")
    AND length(btrim("extraction_method")) BETWEEN 1 AND 128
  ),
  CONSTRAINT "knowledge_claims_metadata_chk" CHECK (
    jsonb_typeof("extraction_metadata") = 'object'
    AND octet_length(convert_to("extraction_metadata"::text, 'UTF8')) <= 16384
    AND ("model_provider" IS NULL OR length("model_provider") BETWEEN 1 AND 128)
    AND ("model_name" IS NULL OR length("model_name") BETWEEN 1 AND 256)
    AND ("model_version" IS NULL OR length("model_version") BETWEEN 1 AND 256)
  ),
  CONSTRAINT "knowledge_claims_audit_chk" CHECK (
    length(btrim("operation_id")) BETWEEN 1 AND 256
    AND "input_hash" ~ '^[0-9a-f]{64}$'
    AND opengeni_private.scoped_knowledge_actor_valid(
      "actor_kind", "actor_subject_id", "initiating_human_subject_id"
    )
  ),
  CONSTRAINT "knowledge_claims_operation_uq" UNIQUE ("account_id", "operation_id"),
  CONSTRAINT "knowledge_claims_scope_identity_uq"
    UNIQUE ("account_id", "id", "scope_key")
);

CREATE INDEX "knowledge_claims_fact_timeline_idx"
  ON "knowledge_claims" ("fact_id", "effective_at" DESC, "created_at" DESC);

CREATE TABLE "knowledge_claim_relations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "scope_kind" text NOT NULL,
  "scope_workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "scope_subject_id" text,
  "scope_key" text NOT NULL,
  "relation_type" text NOT NULL,
  "from_claim_id" uuid NOT NULL,
  "to_claim_id" uuid NOT NULL,
  "operation_id" text NOT NULL,
  "input_hash" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "initiating_human_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_claim_relations_from_fk"
    FOREIGN KEY ("account_id", "from_claim_id", "scope_key")
    REFERENCES "knowledge_claims"("account_id", "id", "scope_key") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_claim_relations_to_fk"
    FOREIGN KEY ("account_id", "to_claim_id", "scope_key")
    REFERENCES "knowledge_claims"("account_id", "id", "scope_key") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_claim_relations_scope_chk" CHECK (
    opengeni_private.scoped_knowledge_scope_valid(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
    AND "scope_key" = opengeni_private.scoped_knowledge_scope_key(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
  ),
  CONSTRAINT "knowledge_claim_relations_shape_chk" CHECK (
    "relation_type" IN ('supersedes', 'conflicts_with')
    AND "from_claim_id" <> "to_claim_id"
    AND (
      "relation_type" <> 'conflicts_with'
      OR "from_claim_id"::text < "to_claim_id"::text
    )
  ),
  CONSTRAINT "knowledge_claim_relations_audit_chk" CHECK (
    length(btrim("operation_id")) BETWEEN 1 AND 256
    AND "input_hash" ~ '^[0-9a-f]{64}$'
    AND opengeni_private.scoped_knowledge_actor_valid(
      "actor_kind", "actor_subject_id", "initiating_human_subject_id"
    )
  ),
  CONSTRAINT "knowledge_claim_relations_natural_identity_uq"
    UNIQUE ("relation_type", "from_claim_id", "to_claim_id"),
  CONSTRAINT "knowledge_claim_relations_operation_uq" UNIQUE ("account_id", "operation_id")
);

CREATE TABLE "knowledge_claim_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "scope_kind" text NOT NULL,
  "scope_workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "scope_subject_id" text,
  "scope_key" text NOT NULL,
  "claim_id" uuid NOT NULL,
  "document_version_id" uuid NOT NULL,
  "polarity" text NOT NULL,
  "document_chunk_id" uuid,
  "chunk_index" integer,
  "locator" text,
  "quote_hash" text,
  "content_hash" text NOT NULL,
  "operation_id" text NOT NULL,
  "input_hash" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "initiating_human_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_claim_evidence_claim_fk"
    FOREIGN KEY ("account_id", "claim_id", "scope_key")
    REFERENCES "knowledge_claims"("account_id", "id", "scope_key") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_claim_evidence_version_fk"
    FOREIGN KEY ("account_id", "document_version_id", "scope_key")
    REFERENCES "knowledge_document_versions"("account_id", "id", "scope_key") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_claim_evidence_scope_chk" CHECK (
    opengeni_private.scoped_knowledge_scope_valid(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
    AND "scope_key" = opengeni_private.scoped_knowledge_scope_key(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
  ),
  CONSTRAINT "knowledge_claim_evidence_location_chk" CHECK (
    "polarity" IN ('supports', 'contradicts')
    AND ("chunk_index" IS NULL OR "chunk_index" >= 0)
    AND ("locator" IS NULL OR length("locator") BETWEEN 1 AND 2048)
    AND ("quote_hash" IS NULL OR "quote_hash" ~ '^[0-9a-f]{64}$')
    AND "content_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "knowledge_claim_evidence_audit_chk" CHECK (
    length(btrim("operation_id")) BETWEEN 1 AND 256
    AND "input_hash" ~ '^[0-9a-f]{64}$'
    AND opengeni_private.scoped_knowledge_actor_valid(
      "actor_kind", "actor_subject_id", "initiating_human_subject_id"
    )
  ),
  CONSTRAINT "knowledge_claim_evidence_operation_uq" UNIQUE ("account_id", "operation_id"),
  CONSTRAINT "knowledge_claim_evidence_scope_identity_uq"
    UNIQUE ("account_id", "id", "scope_key"),
  CONSTRAINT "knowledge_claim_evidence_claim_identity_uq"
    UNIQUE ("account_id", "id", "claim_id", "scope_key")
);

CREATE UNIQUE INDEX "knowledge_claim_evidence_natural_identity_uq"
  ON "knowledge_claim_evidence" (
    "claim_id", "document_version_id", "polarity",
    coalesce("document_chunk_id"::text, ''), coalesce("locator", '')
  );
CREATE INDEX "knowledge_claim_evidence_claim_polarity_idx"
  ON "knowledge_claim_evidence" ("claim_id", "polarity", "created_at");

CREATE TABLE "knowledge_claim_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "scope_kind" text NOT NULL,
  "scope_workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "scope_subject_id" text,
  "scope_key" text NOT NULL,
  "claim_id" uuid NOT NULL,
  "review_revision" bigint NOT NULL DEFAULT nextval('knowledge_claim_review_revision_seq'),
  "state" text NOT NULL,
  "reason" text NOT NULL,
  "operation_id" text NOT NULL,
  "input_hash" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "initiating_human_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_claim_reviews_claim_fk"
    FOREIGN KEY ("account_id", "claim_id", "scope_key")
    REFERENCES "knowledge_claims"("account_id", "id", "scope_key") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_claim_reviews_scope_chk" CHECK (
    opengeni_private.scoped_knowledge_scope_valid(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
    AND "scope_key" = opengeni_private.scoped_knowledge_scope_key(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
  ),
  CONSTRAINT "knowledge_claim_reviews_review_chk" CHECK (
    "state" IN ('proposed', 'approved', 'rejected', 'revoked')
    AND "review_revision" > 0
    AND length(btrim("reason")) BETWEEN 1 AND 4096
    AND (
      "state" = 'proposed'
      OR ("actor_kind" = 'human' AND "actor_subject_id" = "initiating_human_subject_id")
    )
  ),
  CONSTRAINT "knowledge_claim_reviews_audit_chk" CHECK (
    length(btrim("operation_id")) BETWEEN 1 AND 256
    AND "input_hash" ~ '^[0-9a-f]{64}$'
    AND opengeni_private.scoped_knowledge_actor_valid(
      "actor_kind", "actor_subject_id", "initiating_human_subject_id"
    )
  ),
  CONSTRAINT "knowledge_claim_reviews_claim_revision_uq"
    UNIQUE ("claim_id", "review_revision"),
  CONSTRAINT "knowledge_claim_reviews_operation_uq" UNIQUE ("account_id", "operation_id")
);

CREATE INDEX "knowledge_claim_reviews_claim_timeline_idx"
  ON "knowledge_claim_reviews" ("claim_id", "review_revision" DESC);

CREATE TABLE "knowledge_change_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "scope_kind" text NOT NULL,
  "scope_workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "scope_subject_id" text,
  "scope_key" text NOT NULL,
  "target_kind" text NOT NULL,
  "target_scope" text NOT NULL,
  "target_key" text,
  "content" text NOT NULL,
  "content_hash" text NOT NULL,
  "claim_id" uuid NOT NULL,
  "evidence_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'proposed',
  "operation_id" text NOT NULL,
  "input_hash" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "initiating_human_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_change_proposals_claim_fk"
    FOREIGN KEY ("account_id", "claim_id", "scope_key")
    REFERENCES "knowledge_claims"("account_id", "id", "scope_key") ON DELETE RESTRICT,
  CONSTRAINT "knowledge_change_proposals_evidence_fk"
    FOREIGN KEY ("account_id", "evidence_id", "claim_id", "scope_key")
    REFERENCES "knowledge_claim_evidence"("account_id", "id", "claim_id", "scope_key")
    ON DELETE RESTRICT,
  CONSTRAINT "knowledge_change_proposals_scope_chk" CHECK (
    opengeni_private.scoped_knowledge_scope_valid(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
    AND "scope_key" = opengeni_private.scoped_knowledge_scope_key(
      "scope_kind", "scope_workspace_id", "scope_subject_id"
    )
  ),
  CONSTRAINT "knowledge_change_proposals_target_chk" CHECK (
    (
      "target_kind" = 'instruction_policy'
      AND (
        ("target_scope" = 'global' AND "target_key" IS NULL)
        OR ("target_scope" = 'role' AND length(btrim("target_key")) BETWEEN 1 AND 96)
      )
    ) OR (
      "target_kind" = 'preference'
      AND "target_scope" IN ('organization', 'workspace', 'personal')
      AND "target_key" = lower(btrim("target_key"))
      AND length("target_key") BETWEEN 1 AND 96
      AND "target_key" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'
    )
  ),
  CONSTRAINT "knowledge_change_proposals_content_chk" CHECK (
    "status" = 'proposed'
    AND length(btrim("content")) > 0
    AND octet_length("content") <= 1048576
    AND "content_hash" ~ '^[0-9a-f]{64}$'
    AND "content_hash" = encode(sha256(convert_to("content", 'UTF8')), 'hex')
  ),
  CONSTRAINT "knowledge_change_proposals_audit_chk" CHECK (
    length(btrim("operation_id")) BETWEEN 1 AND 256
    AND "input_hash" ~ '^[0-9a-f]{64}$'
    AND opengeni_private.scoped_knowledge_actor_valid(
      "actor_kind", "actor_subject_id", "initiating_human_subject_id"
    )
  ),
  CONSTRAINT "knowledge_change_proposals_operation_uq" UNIQUE ("account_id", "operation_id")
);

CREATE INDEX "knowledge_change_proposals_claim_timeline_idx"
  ON "knowledge_change_proposals" ("claim_id", "created_at" DESC);

DO $scope_workspace_fks$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'knowledge_providers',
    'knowledge_sources',
    'knowledge_source_acl_versions',
    'knowledge_sync_runs',
    'knowledge_source_objects',
    'knowledge_document_versions',
    'knowledge_lifecycle_events',
    'knowledge_entities',
    'knowledge_entity_aliases',
    'knowledge_facts',
    'knowledge_claims',
    'knowledge_claim_relations',
    'knowledge_claim_evidence',
    'knowledge_claim_reviews',
    'knowledge_change_proposals'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I '
      || 'FOREIGN KEY (scope_workspace_id, account_id) '
      || 'REFERENCES workspaces(id, account_id) ON DELETE RESTRICT',
      table_name,
      table_name || '_scope_workspace_account_fk'
    );
  END LOOP;
END
$scope_workspace_fks$;

CREATE OR REPLACE FUNCTION scoped_knowledge_guard_head_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_value jsonb := to_jsonb(NEW);
BEGIN
  IF TG_TABLE_NAME = 'knowledge_providers' THEN
    IF row_value->>'lifecycle_state' <> 'active'
      OR (row_value->>'lifecycle_generation')::bigint <> 1
    THEN
      RAISE EXCEPTION 'knowledge provider must start active at generation one'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'knowledge_sources' THEN
    IF row_value->>'lifecycle_state' <> 'active'
      OR (row_value->>'lifecycle_generation')::bigint <> 1
      OR (row_value->>'sync_generation')::bigint <> 0
      OR row_value->'current_acl_generation' <> 'null'::jsonb
      OR row_value->'sync_cursor' <> 'null'::jsonb
    THEN
      RAISE EXCEPTION 'knowledge source initial lifecycle, ACL, and sync state is invalid'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'knowledge_source_objects' THEN
    IF row_value->>'lifecycle_state' <> 'active'
      OR (row_value->>'lifecycle_generation')::bigint <> 1
      OR (row_value->>'version_generation')::bigint <> 0
      OR row_value->'current_version_id' <> 'null'::jsonb
    THEN
      RAISE EXCEPTION 'knowledge source object must start active without a current version'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DO $insert_guard_functions$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.scoped_knowledge_guard_acl_insert()
    RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE source_row knowledge_sources%%ROWTYPE;
    BEGIN
      IF NEW.account_id IS DISTINCT FROM opengeni_private.current_account_id()
        OR NOT opengeni_private.scoped_knowledge_scope_visible(
          NEW.account_id, NEW.scope_kind, NEW.scope_workspace_id, NEW.scope_subject_id
        )
        OR NOT opengeni_private.scoped_knowledge_actor_authorized(
          NEW.actor_kind, NEW.actor_subject_id, NEW.initiating_human_subject_id
        )
      THEN
        RAISE EXCEPTION 'knowledge ACL insert authority is invalid'
          USING ERRCODE = '42501';
      END IF;
      SELECT * INTO source_row
      FROM knowledge_sources source
      WHERE source.id = NEW.source_id
        AND source.account_id = NEW.account_id
        AND source.scope_key = NEW.source_scope_key
        AND opengeni_private.scoped_knowledge_scope_visible(
          source.account_id, source.scope_kind,
          source.scope_workspace_id, source.scope_subject_id
        )
      FOR UPDATE;
      IF NOT FOUND
        OR NEW.generation > coalesce(source_row.current_acl_generation, 0) + 1
        OR (
          NEW.generation = coalesce(source_row.current_acl_generation, 0) + 1
          AND source_row.lifecycle_state <> 'active'
        )
      THEN
        RAISE EXCEPTION 'knowledge ACL insert is outside the current source generation fence'
          USING ERRCODE = '40001';
      END IF;
      RETURN NEW;
    END;
    $body$;

    CREATE OR REPLACE FUNCTION %1$I.scoped_knowledge_guard_sync_insert()
    RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE source_row knowledge_sources%%ROWTYPE;
    BEGIN
      IF NEW.account_id IS DISTINCT FROM opengeni_private.current_account_id()
        OR NOT opengeni_private.scoped_knowledge_scope_visible(
          NEW.account_id, NEW.scope_kind, NEW.scope_workspace_id, NEW.scope_subject_id
        )
        OR NOT opengeni_private.scoped_knowledge_actor_authorized(
          NEW.actor_kind, NEW.actor_subject_id, NEW.initiating_human_subject_id
        )
      THEN
        RAISE EXCEPTION 'knowledge sync insert authority is invalid'
          USING ERRCODE = '42501';
      END IF;
      SELECT * INTO source_row
      FROM knowledge_sources source
      WHERE source.id = NEW.source_id
        AND source.account_id = NEW.account_id
        AND source.scope_key = NEW.scope_key
        AND source.scope_kind = NEW.scope_kind
        AND source.scope_workspace_id IS NOT DISTINCT FROM NEW.scope_workspace_id
        AND source.scope_subject_id IS NOT DISTINCT FROM NEW.scope_subject_id
        AND opengeni_private.scoped_knowledge_scope_visible(
          source.account_id, source.scope_kind,
          source.scope_workspace_id, source.scope_subject_id
        )
      FOR UPDATE;
      IF NOT FOUND
        OR source_row.lifecycle_state <> 'active'
        OR NEW.state <> 'started'
        OR NEW.input_lifecycle_generation <> source_row.lifecycle_generation
        OR NEW.input_sync_generation <> source_row.sync_generation
        OR NEW.input_cursor IS DISTINCT FROM source_row.sync_cursor
      THEN
        RAISE EXCEPTION 'knowledge sync insert is outside the current source generation fence'
          USING ERRCODE = '40001';
      END IF;
      RETURN NEW;
    END;
    $body$;

    CREATE OR REPLACE FUNCTION %1$I.scoped_knowledge_guard_version_insert()
    RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE object_row knowledge_source_objects%%ROWTYPE;
    DECLARE source_row knowledge_sources%%ROWTYPE;
    BEGIN
      IF NEW.account_id IS DISTINCT FROM opengeni_private.current_account_id()
        OR NOT opengeni_private.scoped_knowledge_scope_visible(
          NEW.account_id, NEW.scope_kind, NEW.scope_workspace_id, NEW.scope_subject_id
        )
        OR NOT opengeni_private.scoped_knowledge_actor_authorized(
          NEW.actor_kind, NEW.actor_subject_id, NEW.initiating_human_subject_id
        )
      THEN
        RAISE EXCEPTION 'knowledge document version insert authority is invalid'
          USING ERRCODE = '42501';
      END IF;
      SELECT * INTO object_row
      FROM knowledge_source_objects object
      WHERE object.id = NEW.object_id
        AND object.account_id = NEW.account_id
        AND object.source_id = NEW.source_id
        AND object.scope_key = NEW.scope_key
        AND object.scope_kind = NEW.scope_kind
        AND object.scope_workspace_id IS NOT DISTINCT FROM NEW.scope_workspace_id
        AND object.scope_subject_id IS NOT DISTINCT FROM NEW.scope_subject_id
        AND opengeni_private.scoped_knowledge_scope_visible(
          object.account_id, object.scope_kind,
          object.scope_workspace_id, object.scope_subject_id
        )
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'knowledge document version object is outside the exact scope'
          USING ERRCODE = '23514';
      END IF;
      SELECT * INTO source_row
      FROM knowledge_sources source
      WHERE source.id = NEW.source_id
        AND source.account_id = NEW.account_id
        AND source.scope_key = NEW.scope_key
        AND source.scope_kind = NEW.scope_kind
        AND source.scope_workspace_id IS NOT DISTINCT FROM NEW.scope_workspace_id
        AND source.scope_subject_id IS NOT DISTINCT FROM NEW.scope_subject_id
        AND opengeni_private.scoped_knowledge_scope_visible(
          source.account_id, source.scope_kind,
          source.scope_workspace_id, source.scope_subject_id
        )
      FOR UPDATE;
      IF NOT FOUND
        OR NEW.version_generation > object_row.version_generation + 1
        OR (
          NEW.version_generation = object_row.version_generation + 1
          AND (
            object_row.lifecycle_state <> 'active'
            OR source_row.lifecycle_state <> 'active'
            OR NEW.acl_generation IS DISTINCT FROM source_row.current_acl_generation
          )
        )
      THEN
        RAISE EXCEPTION 'knowledge document version is outside the current object/source fence'
          USING ERRCODE = '40001';
      END IF;
      RETURN NEW;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.scoped_knowledge_guard_acl_insert() FROM PUBLIC',
    data_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.scoped_knowledge_guard_sync_insert() FROM PUBLIC',
    data_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.scoped_knowledge_guard_version_insert() FROM PUBLIC',
    data_schema
  );
END
$insert_guard_functions$;

CREATE TRIGGER knowledge_providers_10_initial_guard
  BEFORE INSERT ON "knowledge_providers"
  FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_guard_head_insert();
CREATE TRIGGER knowledge_sources_10_initial_guard
  BEFORE INSERT ON "knowledge_sources"
  FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_guard_head_insert();
CREATE TRIGGER knowledge_source_objects_10_initial_guard
  BEFORE INSERT ON "knowledge_source_objects"
  FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_guard_head_insert();
CREATE TRIGGER knowledge_source_acl_versions_10_generation_guard
  BEFORE INSERT ON "knowledge_source_acl_versions"
  FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_guard_acl_insert();
CREATE TRIGGER knowledge_sync_runs_10_generation_guard
  BEFORE INSERT ON "knowledge_sync_runs"
  FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_guard_sync_insert();
CREATE TRIGGER knowledge_document_versions_10_generation_guard
  BEFORE INSERT ON "knowledge_document_versions"
  FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_guard_version_insert();

CREATE OR REPLACE FUNCTION scoped_knowledge_validate_bridge()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version_document_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'knowledge_source_objects' THEN
    IF NEW.document_id IS NOT NULL THEN
      IF NEW.scope_workspace_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.document_id
          AND document.account_id = NEW.account_id
          AND document.workspace_id = NEW.scope_workspace_id
      ) THEN
        RAISE EXCEPTION 'knowledge source object document bridge is outside its exact account/workspace'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'knowledge_document_versions' THEN
    IF NOT EXISTS (
      SELECT 1 FROM knowledge_source_acl_versions acl
      WHERE acl.id = NEW.acl_version_id
        AND acl.account_id = NEW.account_id
        AND acl.source_id = NEW.source_id
        AND acl.generation = NEW.acl_generation
    ) THEN
      RAISE EXCEPTION 'knowledge document version ACL reference is not exact'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.document_id IS NULL AND NEW.file_id IS NOT NULL THEN
      RAISE EXCEPTION 'knowledge document version file bridge requires a document bridge'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.document_id IS NOT NULL AND (
      NEW.scope_workspace_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM documents document
        WHERE document.id = NEW.document_id
          AND document.account_id = NEW.account_id
          AND document.workspace_id = NEW.scope_workspace_id
          AND (NEW.file_id IS NULL OR document.file_id = NEW.file_id)
      )
    ) THEN
      RAISE EXCEPTION 'knowledge document version bridge is outside its exact account/workspace/file'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'knowledge_claim_evidence' THEN
    IF NEW.document_chunk_id IS NOT NULL THEN
      SELECT document_id INTO version_document_id
      FROM knowledge_document_versions
      WHERE id = NEW.document_version_id;
      IF version_document_id IS NULL OR NEW.scope_workspace_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM document_chunks chunk
        WHERE chunk.id = NEW.document_chunk_id
          AND chunk.account_id = NEW.account_id
          AND chunk.workspace_id = NEW.scope_workspace_id
          AND chunk.document_id = version_document_id
          AND (NEW.chunk_index IS NULL OR chunk.chunk_index = NEW.chunk_index)
      ) THEN
        RAISE EXCEPTION 'knowledge claim evidence chunk bridge is not exact'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_source_objects_20_validate_bridge
  BEFORE INSERT ON "knowledge_source_objects"
  FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_validate_bridge();
CREATE TRIGGER knowledge_document_versions_20_validate_bridge
  BEFORE INSERT ON "knowledge_document_versions"
  FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_validate_bridge();
CREATE TRIGGER knowledge_claim_evidence_20_validate_bridge
  BEFORE INSERT ON "knowledge_claim_evidence"
  FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_validate_bridge();

CREATE OR REPLACE FUNCTION scoped_knowledge_validate_claim_relation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.account_id::text || ':' || NEW.scope_key, 0)
  );
  IF NEW.relation_type = 'supersedes' AND EXISTS (
    WITH RECURSIVE path(claim_id) AS (
      SELECT relation.to_claim_id
      FROM knowledge_claim_relations relation
      WHERE relation.account_id = NEW.account_id
        AND relation.scope_key = NEW.scope_key
        AND relation.relation_type = 'supersedes'
        AND relation.from_claim_id = NEW.to_claim_id
      UNION
      SELECT relation.to_claim_id
      FROM knowledge_claim_relations relation
      JOIN path ON relation.from_claim_id = path.claim_id
      WHERE relation.account_id = NEW.account_id
        AND relation.scope_key = NEW.scope_key
        AND relation.relation_type = 'supersedes'
    )
    SELECT 1 FROM path WHERE claim_id = NEW.from_claim_id
  ) THEN
    RAISE EXCEPTION 'knowledge claim supersession cannot create a cycle'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_claim_relations_validate
  BEFORE INSERT ON "knowledge_claim_relations"
  FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_validate_claim_relation();

CREATE OR REPLACE FUNCTION scoped_knowledge_reject_immutable_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'scoped knowledge provenance is immutable' USING ERRCODE = '55000';
END;
$$;

DO $immutable_triggers$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'knowledge_source_acl_versions',
    'knowledge_document_versions',
    'knowledge_lifecycle_events',
    'knowledge_entities',
    'knowledge_entity_aliases',
    'knowledge_facts',
    'knowledge_claims',
    'knowledge_claim_relations',
    'knowledge_claim_evidence',
    'knowledge_claim_reviews',
    'knowledge_change_proposals'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I '
      || 'FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_reject_immutable_mutation()',
      table_name || '_immutable', table_name
    );
  END LOOP;
END
$immutable_triggers$;

CREATE OR REPLACE FUNCTION scoped_knowledge_guard_provider_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'knowledge provider tombstones are not deleted' USING ERRCODE = '55000';
  END IF;
  IF current_setting('opengeni.knowledge_mutation_kind', true) <> 'lifecycle'
    OR current_setting('opengeni.knowledge_mutation_target', true) <> OLD.id::text
    OR (to_jsonb(NEW) - ARRAY['lifecycle_state', 'lifecycle_generation', 'updated_at'])
      IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['lifecycle_state', 'lifecycle_generation', 'updated_at'])
    OR NEW.lifecycle_generation <> OLD.lifecycle_generation + 1
    OR NOT (
      (OLD.lifecycle_state = 'active' AND NEW.lifecycle_state IN ('deleted', 'revoked'))
      OR (OLD.lifecycle_state IN ('deleted', 'revoked') AND NEW.lifecycle_state = 'active')
    )
  THEN
    RAISE EXCEPTION 'invalid knowledge provider lifecycle mutation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION scoped_knowledge_guard_source_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutation_kind text := current_setting('opengeni.knowledge_mutation_kind', true);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'knowledge source tombstones are not deleted' USING ERRCODE = '55000';
  END IF;
  IF current_setting('opengeni.knowledge_mutation_target', true) <> OLD.id::text THEN
    RAISE EXCEPTION 'knowledge source mutation target is not fenced' USING ERRCODE = '55000';
  END IF;
  IF mutation_kind = 'lifecycle' THEN
    IF (to_jsonb(NEW) - ARRAY['lifecycle_state', 'lifecycle_generation', 'updated_at'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['lifecycle_state', 'lifecycle_generation', 'updated_at'])
      OR NEW.lifecycle_generation <> OLD.lifecycle_generation + 1
      OR NOT (
        (OLD.lifecycle_state = 'active' AND NEW.lifecycle_state IN ('deleted', 'revoked'))
        OR (OLD.lifecycle_state IN ('deleted', 'revoked') AND NEW.lifecycle_state = 'active')
      )
    THEN
      RAISE EXCEPTION 'invalid knowledge source lifecycle mutation' USING ERRCODE = '23514';
    END IF;
  ELSIF mutation_kind = 'acl' THEN
    IF (to_jsonb(NEW) - ARRAY['current_acl_generation', 'updated_at'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['current_acl_generation', 'updated_at'])
      OR NEW.lifecycle_state <> 'active'
      OR NEW.current_acl_generation IS NULL
      OR NEW.current_acl_generation <> coalesce(OLD.current_acl_generation, 0) + 1
    THEN
      RAISE EXCEPTION 'invalid knowledge source ACL mutation' USING ERRCODE = '23514';
    END IF;
  ELSIF mutation_kind = 'sync' THEN
    IF (to_jsonb(NEW) - ARRAY['sync_generation', 'sync_cursor', 'updated_at'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['sync_generation', 'sync_cursor', 'updated_at'])
      OR NEW.lifecycle_state <> 'active'
      OR NEW.sync_generation <> OLD.sync_generation + 1
    THEN
      RAISE EXCEPTION 'invalid knowledge source sync mutation' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'knowledge source mutation kind is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION scoped_knowledge_guard_object_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutation_kind text := current_setting('opengeni.knowledge_mutation_kind', true);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'knowledge source object tombstones are not deleted' USING ERRCODE = '55000';
  END IF;
  IF current_setting('opengeni.knowledge_mutation_target', true) <> OLD.id::text THEN
    RAISE EXCEPTION 'knowledge source object mutation target is not fenced' USING ERRCODE = '55000';
  END IF;
  IF mutation_kind = 'lifecycle' THEN
    IF (to_jsonb(NEW) - ARRAY['lifecycle_state', 'lifecycle_generation', 'updated_at'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['lifecycle_state', 'lifecycle_generation', 'updated_at'])
      OR NEW.lifecycle_generation <> OLD.lifecycle_generation + 1
      OR NOT (
        (OLD.lifecycle_state = 'active' AND NEW.lifecycle_state IN ('deleted', 'revoked'))
        OR (OLD.lifecycle_state IN ('deleted', 'revoked') AND NEW.lifecycle_state = 'active')
      )
    THEN
      RAISE EXCEPTION 'invalid knowledge source object lifecycle mutation'
        USING ERRCODE = '23514';
    END IF;
  ELSIF mutation_kind = 'version' THEN
    IF (to_jsonb(NEW) - ARRAY['version_generation', 'current_version_id', 'updated_at'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['version_generation', 'current_version_id', 'updated_at'])
      OR NEW.lifecycle_state <> 'active'
      OR NEW.current_version_id IS NULL
      OR NEW.version_generation <> OLD.version_generation + 1
    THEN
      RAISE EXCEPTION 'invalid knowledge source object version mutation'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'knowledge source object mutation kind is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION scoped_knowledge_guard_sync_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'knowledge sync runs are not deleted' USING ERRCODE = '55000';
  END IF;
  IF current_setting('opengeni.knowledge_mutation_kind', true) <> 'sync_complete'
    OR current_setting('opengeni.knowledge_mutation_target', true) <> OLD.id::text
    OR (to_jsonb(NEW) - ARRAY[
      'state', 'output_cursor', 'watermark', 'metadata', 'error_code',
      'completion_hash', 'completed_at'
    ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
      'state', 'output_cursor', 'watermark', 'metadata', 'error_code',
      'completion_hash', 'completed_at'
    ])
    OR OLD.state <> 'started'
    OR NEW.state NOT IN ('succeeded', 'failed')
  THEN
    RAISE EXCEPTION 'invalid knowledge sync completion mutation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_providers_lifecycle_only
  BEFORE UPDATE OR DELETE ON "knowledge_providers"
  FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_guard_provider_mutation();
CREATE TRIGGER knowledge_sources_mutation_guard
  BEFORE UPDATE OR DELETE ON "knowledge_sources"
  FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_guard_source_mutation();
CREATE TRIGGER knowledge_source_objects_mutation_guard
  BEFORE UPDATE OR DELETE ON "knowledge_source_objects"
  FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_guard_object_mutation();
CREATE TRIGGER knowledge_sync_runs_completion_only
  BEFORE UPDATE OR DELETE ON "knowledge_sync_runs"
  FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_guard_sync_mutation();

DO $lifecycle_function$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.scoped_knowledge_apply_lifecycle(
      p_account_id uuid,
      p_target_kind text,
      p_target_id uuid,
      p_event_type text,
      p_expected_generation bigint,
      p_operation_id text,
      p_input_hash text,
      p_reason_code text,
      p_actor_kind text,
      p_actor_subject_id text,
      p_initiating_human_subject_id text
    ) RETURNS TABLE (
      target_id uuid,
      lifecycle_state text,
      lifecycle_generation bigint,
      replayed boolean
    )
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE target_row record;
    DECLARE prior_event knowledge_lifecycle_events%%ROWTYPE;
    DECLARE next_state text;
    DECLARE provider_ref uuid;
    DECLARE source_ref uuid;
    DECLARE object_ref uuid;
    BEGIN
      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
        OR p_target_kind NOT IN ('provider', 'source', 'object')
        OR p_event_type NOT IN ('deleted', 'revoked', 'restored')
        OR NOT opengeni_private.scoped_knowledge_actor_authorized(
          p_actor_kind, p_actor_subject_id, p_initiating_human_subject_id
        )
      THEN
        RAISE EXCEPTION 'scoped knowledge lifecycle authority is invalid'
          USING ERRCODE = '42501';
      END IF;

      SELECT * INTO prior_event
      FROM knowledge_lifecycle_events event
      WHERE event.account_id = p_account_id
        AND event.target_kind = p_target_kind
        AND opengeni_private.scoped_knowledge_scope_visible(
          event.account_id, event.scope_kind, event.scope_workspace_id, event.scope_subject_id
        )
        AND event.provider_id IS NOT DISTINCT FROM
          CASE WHEN p_target_kind = 'provider' THEN p_target_id ELSE NULL END
        AND event.source_id IS NOT DISTINCT FROM
          CASE WHEN p_target_kind = 'source' THEN p_target_id ELSE NULL END
        AND event.object_id IS NOT DISTINCT FROM
          CASE WHEN p_target_kind = 'object' THEN p_target_id ELSE NULL END
        AND event.operation_id = p_operation_id;
      IF FOUND THEN
        IF prior_event.input_hash <> p_input_hash OR prior_event.event_type <> p_event_type THEN
          RAISE EXCEPTION 'knowledge lifecycle operation id was replayed with different input'
            USING ERRCODE = '23505';
        END IF;
        RETURN QUERY SELECT p_target_id, prior_event.new_state,
          prior_event.new_generation, true;
        RETURN;
      END IF;

      IF p_target_kind = 'provider' THEN
        SELECT * INTO target_row FROM knowledge_providers row
        WHERE row.id = p_target_id AND row.account_id = p_account_id
          AND opengeni_private.scoped_knowledge_scope_visible(
            row.account_id, row.scope_kind, row.scope_workspace_id, row.scope_subject_id
          )
        FOR UPDATE;
        provider_ref := p_target_id;
      ELSIF p_target_kind = 'source' THEN
        SELECT * INTO target_row FROM knowledge_sources row
        WHERE row.id = p_target_id AND row.account_id = p_account_id
          AND opengeni_private.scoped_knowledge_scope_visible(
            row.account_id, row.scope_kind, row.scope_workspace_id, row.scope_subject_id
          )
        FOR UPDATE;
        source_ref := p_target_id;
      ELSE
        SELECT * INTO target_row FROM knowledge_source_objects row
        WHERE row.id = p_target_id AND row.account_id = p_account_id
          AND opengeni_private.scoped_knowledge_scope_visible(
            row.account_id, row.scope_kind, row.scope_workspace_id, row.scope_subject_id
          )
        FOR UPDATE;
        object_ref := p_target_id;
      END IF;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'knowledge lifecycle target was not found' USING ERRCODE = 'P0002';
      END IF;
      IF target_row.lifecycle_generation <> p_expected_generation THEN
        RAISE EXCEPTION 'knowledge lifecycle generation changed' USING ERRCODE = '40001';
      END IF;
      IF p_event_type = 'restored' THEN
        IF target_row.lifecycle_state NOT IN ('deleted', 'revoked') THEN
          RAISE EXCEPTION 'only a tombstoned knowledge target can be restored'
            USING ERRCODE = '23514';
        END IF;
        next_state := 'active';
      ELSE
        IF target_row.lifecycle_state <> 'active' THEN
          RAISE EXCEPTION 'ordinary lifecycle mutation cannot resurrect a knowledge tombstone'
            USING ERRCODE = '23514';
        END IF;
        next_state := CASE p_event_type WHEN 'deleted' THEN 'deleted' ELSE 'revoked' END;
      END IF;

      PERFORM set_config('opengeni.knowledge_mutation_kind', 'lifecycle', true);
      PERFORM set_config('opengeni.knowledge_mutation_target', p_target_id::text, true);
      IF p_target_kind = 'provider' THEN
        UPDATE knowledge_providers target_provider SET lifecycle_state = next_state,
          lifecycle_generation = target_provider.lifecycle_generation + 1,
          updated_at = clock_timestamp()
        WHERE target_provider.id = p_target_id;
      ELSIF p_target_kind = 'source' THEN
        UPDATE knowledge_sources target_source SET lifecycle_state = next_state,
          lifecycle_generation = target_source.lifecycle_generation + 1,
          updated_at = clock_timestamp()
        WHERE target_source.id = p_target_id;
      ELSE
        UPDATE knowledge_source_objects target_object SET lifecycle_state = next_state,
          lifecycle_generation = target_object.lifecycle_generation + 1,
          updated_at = clock_timestamp()
        WHERE target_object.id = p_target_id;
      END IF;

      INSERT INTO knowledge_lifecycle_events (
        account_id, scope_kind, scope_workspace_id, scope_subject_id, scope_key,
        target_kind, provider_id, source_id, object_id, event_type,
        old_state, new_state, old_generation, new_generation,
        operation_id, input_hash, reason_code, actor_kind, actor_subject_id,
        initiating_human_subject_id
      ) VALUES (
        p_account_id, target_row.scope_kind, target_row.scope_workspace_id,
        target_row.scope_subject_id, target_row.scope_key,
        p_target_kind, provider_ref, source_ref, object_ref, p_event_type,
        target_row.lifecycle_state, next_state, target_row.lifecycle_generation,
        target_row.lifecycle_generation + 1, p_operation_id, p_input_hash,
        p_reason_code, p_actor_kind, p_actor_subject_id, p_initiating_human_subject_id
      );
      RETURN QUERY SELECT p_target_id, next_state,
        target_row.lifecycle_generation + 1, false;
    END;
    $body$;
  $ddl$, data_schema);
END
$lifecycle_function$;

DO $source_acl_function$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.scoped_knowledge_advance_source_acl(
      p_account_id uuid,
      p_source_id uuid,
      p_expected_lifecycle_generation bigint,
      p_expected_acl_generation bigint,
      p_acl_version_id uuid,
      p_operation_id text,
      p_input_hash text,
      p_reason_code text,
      p_actor_kind text,
      p_actor_subject_id text,
      p_initiating_human_subject_id text
    ) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE source_row knowledge_sources%%ROWTYPE;
    DECLARE acl_row knowledge_source_acl_versions%%ROWTYPE;
    BEGIN
      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
        OR NOT opengeni_private.scoped_knowledge_actor_authorized(
          p_actor_kind, p_actor_subject_id, p_initiating_human_subject_id
        )
      THEN
        RAISE EXCEPTION 'knowledge ACL account authority is invalid' USING ERRCODE = '42501';
      END IF;
      SELECT * INTO source_row FROM knowledge_sources row
      WHERE row.id = p_source_id AND row.account_id = p_account_id
        AND opengeni_private.scoped_knowledge_scope_visible(
          row.account_id, row.scope_kind, row.scope_workspace_id, row.scope_subject_id
        )
      FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'knowledge source was not found' USING ERRCODE = 'P0002'; END IF;
      SELECT * INTO acl_row FROM knowledge_source_acl_versions row
      WHERE row.id = p_acl_version_id AND row.account_id = p_account_id
        AND row.source_id = p_source_id AND row.operation_id = p_operation_id
        AND opengeni_private.scoped_knowledge_scope_visible(
          row.account_id, row.scope_kind, row.scope_workspace_id, row.scope_subject_id
        );
      IF NOT FOUND THEN RAISE EXCEPTION 'knowledge ACL version was not found' USING ERRCODE = 'P0002'; END IF;
      IF source_row.current_acl_generation = acl_row.generation THEN
        IF acl_row.input_hash <> p_input_hash THEN
          RAISE EXCEPTION 'knowledge ACL operation id was replayed with different input'
            USING ERRCODE = '23505';
        END IF;
        RETURN acl_row.generation;
      END IF;
      IF source_row.lifecycle_state <> 'active'
        OR source_row.lifecycle_generation <> p_expected_lifecycle_generation
        OR coalesce(source_row.current_acl_generation, 0) <> p_expected_acl_generation
        OR acl_row.generation <> p_expected_acl_generation + 1
        OR acl_row.input_hash <> p_input_hash
        OR acl_row.actor_kind IS DISTINCT FROM p_actor_kind
        OR acl_row.actor_subject_id IS DISTINCT FROM p_actor_subject_id
        OR acl_row.initiating_human_subject_id IS DISTINCT FROM p_initiating_human_subject_id
      THEN
        RAISE EXCEPTION 'knowledge ACL generation or lifecycle fence changed'
          USING ERRCODE = '40001';
      END IF;
      PERFORM set_config('opengeni.knowledge_mutation_kind', 'acl', true);
      PERFORM set_config('opengeni.knowledge_mutation_target', p_source_id::text, true);
      UPDATE knowledge_sources SET current_acl_generation = acl_row.generation,
        updated_at = clock_timestamp() WHERE id = p_source_id;
      INSERT INTO knowledge_lifecycle_events (
        account_id, scope_kind, scope_workspace_id, scope_subject_id, scope_key,
        target_kind, source_id, event_type, old_state, new_state,
        old_generation, new_generation, operation_id, input_hash, reason_code,
        actor_kind, actor_subject_id, initiating_human_subject_id
      ) VALUES (
        p_account_id, source_row.scope_kind, source_row.scope_workspace_id,
        source_row.scope_subject_id, source_row.scope_key, 'source', p_source_id,
        'acl_changed', source_row.lifecycle_state, source_row.lifecycle_state,
        source_row.lifecycle_generation, source_row.lifecycle_generation,
        p_operation_id, p_input_hash, p_reason_code, p_actor_kind,
        p_actor_subject_id, p_initiating_human_subject_id
      );
      RETURN acl_row.generation;
    END;
    $body$;
  $ddl$, data_schema);
END
$source_acl_function$;

DO $sync_function$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.scoped_knowledge_complete_sync(
      p_account_id uuid,
      p_run_id uuid,
      p_state text,
      p_output_cursor text,
      p_watermark timestamptz,
      p_metadata jsonb,
      p_error_code text,
      p_completion_hash text,
      p_reason_code text
    ) RETURNS SETOF %1$I.knowledge_sync_runs
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE run_row knowledge_sync_runs%%ROWTYPE;
    DECLARE source_row knowledge_sources%%ROWTYPE;
    BEGIN
      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
        OR p_state NOT IN ('succeeded', 'failed')
      THEN
        RAISE EXCEPTION 'knowledge sync completion authority is invalid' USING ERRCODE = '42501';
      END IF;
      SELECT * INTO run_row FROM knowledge_sync_runs row
      WHERE row.id = p_run_id AND row.account_id = p_account_id
        AND opengeni_private.scoped_knowledge_scope_visible(
          row.account_id, row.scope_kind, row.scope_workspace_id, row.scope_subject_id
        )
      FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'knowledge sync run was not found' USING ERRCODE = 'P0002'; END IF;
      IF NOT opengeni_private.scoped_knowledge_actor_authorized(
        run_row.actor_kind, run_row.actor_subject_id, run_row.initiating_human_subject_id
      ) THEN
        RAISE EXCEPTION 'knowledge sync completion actor authority changed'
          USING ERRCODE = '42501';
      END IF;
      IF run_row.state <> 'started' THEN
        IF run_row.state <> p_state OR run_row.completion_hash <> p_completion_hash THEN
          RAISE EXCEPTION 'knowledge sync completion was replayed with different input'
            USING ERRCODE = '23505';
        END IF;
        RETURN NEXT run_row;
        RETURN;
      END IF;
      SELECT * INTO source_row FROM knowledge_sources row
      WHERE row.id = run_row.source_id AND row.account_id = p_account_id
        AND opengeni_private.scoped_knowledge_scope_visible(
          row.account_id, row.scope_kind, row.scope_workspace_id, row.scope_subject_id
        )
      FOR UPDATE;
      IF NOT FOUND OR source_row.lifecycle_state <> 'active'
        OR source_row.lifecycle_generation <> run_row.input_lifecycle_generation
        OR source_row.sync_generation <> run_row.input_sync_generation
      THEN
        RAISE EXCEPTION 'knowledge sync generation or lifecycle fence changed'
          USING ERRCODE = '40001';
      END IF;
      IF p_state = 'succeeded' THEN
        PERFORM set_config('opengeni.knowledge_mutation_kind', 'sync', true);
        PERFORM set_config('opengeni.knowledge_mutation_target', source_row.id::text, true);
        UPDATE knowledge_sources SET sync_generation = sync_generation + 1,
          sync_cursor = p_output_cursor, updated_at = clock_timestamp()
        WHERE id = source_row.id;
      END IF;
      PERFORM set_config('opengeni.knowledge_mutation_kind', 'sync_complete', true);
      PERFORM set_config('opengeni.knowledge_mutation_target', run_row.id::text, true);
      UPDATE knowledge_sync_runs SET state = p_state,
        output_cursor = CASE WHEN p_state = 'succeeded' THEN p_output_cursor ELSE NULL END,
        watermark = p_watermark, metadata = p_metadata,
        error_code = CASE WHEN p_state = 'failed' THEN p_error_code ELSE NULL END,
        completion_hash = p_completion_hash, completed_at = clock_timestamp()
      WHERE id = run_row.id RETURNING * INTO run_row;
      INSERT INTO knowledge_lifecycle_events (
        account_id, scope_kind, scope_workspace_id, scope_subject_id, scope_key,
        target_kind, source_id, event_type, old_state, new_state,
        old_generation, new_generation, operation_id, input_hash, reason_code,
        actor_kind, actor_subject_id, initiating_human_subject_id
      ) VALUES (
        p_account_id, source_row.scope_kind, source_row.scope_workspace_id,
        source_row.scope_subject_id, source_row.scope_key, 'source', source_row.id,
        CASE WHEN p_state = 'succeeded' THEN 'sync_succeeded' ELSE 'sync_failed' END,
        source_row.lifecycle_state, source_row.lifecycle_state,
        source_row.lifecycle_generation, source_row.lifecycle_generation,
        run_row.operation_id, p_completion_hash, p_reason_code,
        run_row.actor_kind, run_row.actor_subject_id, run_row.initiating_human_subject_id
      );
      RETURN NEXT run_row;
    END;
    $body$;
  $ddl$, data_schema);
END
$sync_function$;

DO $object_version_function$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.scoped_knowledge_advance_object_version(
      p_account_id uuid,
      p_object_id uuid,
      p_expected_lifecycle_generation bigint,
      p_expected_version_generation bigint,
      p_version_id uuid,
      p_operation_id text,
      p_input_hash text,
      p_reason_code text,
      p_actor_kind text,
      p_actor_subject_id text,
      p_initiating_human_subject_id text
    ) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE object_row knowledge_source_objects%%ROWTYPE;
    DECLARE version_row knowledge_document_versions%%ROWTYPE;
    DECLARE source_row knowledge_sources%%ROWTYPE;
    BEGIN
      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
        OR NOT opengeni_private.scoped_knowledge_actor_authorized(
          p_actor_kind, p_actor_subject_id, p_initiating_human_subject_id
        )
      THEN
        RAISE EXCEPTION 'knowledge object version account authority is invalid'
          USING ERRCODE = '42501';
      END IF;
      SELECT * INTO object_row FROM knowledge_source_objects row
      WHERE row.id = p_object_id AND row.account_id = p_account_id
        AND opengeni_private.scoped_knowledge_scope_visible(
          row.account_id, row.scope_kind, row.scope_workspace_id, row.scope_subject_id
        )
      FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'knowledge source object was not found' USING ERRCODE = 'P0002'; END IF;
      SELECT * INTO version_row FROM knowledge_document_versions row
      WHERE row.id = p_version_id AND row.account_id = p_account_id
        AND row.object_id = p_object_id AND row.operation_id = p_operation_id
        AND opengeni_private.scoped_knowledge_scope_visible(
          row.account_id, row.scope_kind, row.scope_workspace_id, row.scope_subject_id
        );
      IF NOT FOUND THEN RAISE EXCEPTION 'knowledge document version was not found' USING ERRCODE = 'P0002'; END IF;
      IF object_row.current_version_id = version_row.id THEN
        IF version_row.input_hash <> p_input_hash THEN
          RAISE EXCEPTION 'knowledge document version operation was replayed with different input'
            USING ERRCODE = '23505';
        END IF;
        RETURN version_row.version_generation;
      END IF;
      SELECT * INTO source_row FROM knowledge_sources row
      WHERE row.id = version_row.source_id AND row.account_id = p_account_id
        AND opengeni_private.scoped_knowledge_scope_visible(
          row.account_id, row.scope_kind, row.scope_workspace_id, row.scope_subject_id
        )
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'knowledge document version source was not found'
          USING ERRCODE = 'P0002';
      END IF;
      IF object_row.lifecycle_state <> 'active'
        OR object_row.lifecycle_generation <> p_expected_lifecycle_generation
        OR object_row.version_generation <> p_expected_version_generation
        OR source_row.lifecycle_state <> 'active'
        OR source_row.current_acl_generation IS DISTINCT FROM version_row.acl_generation
        OR version_row.version_generation <> p_expected_version_generation + 1
        OR version_row.input_hash <> p_input_hash
        OR version_row.actor_kind IS DISTINCT FROM p_actor_kind
        OR version_row.actor_subject_id IS DISTINCT FROM p_actor_subject_id
        OR version_row.initiating_human_subject_id IS DISTINCT FROM p_initiating_human_subject_id
      THEN
        RAISE EXCEPTION 'knowledge object version or lifecycle fence changed'
          USING ERRCODE = '40001';
      END IF;
      PERFORM set_config('opengeni.knowledge_mutation_kind', 'version', true);
      PERFORM set_config('opengeni.knowledge_mutation_target', p_object_id::text, true);
      UPDATE knowledge_source_objects SET current_version_id = version_row.id,
        version_generation = version_row.version_generation, updated_at = clock_timestamp()
      WHERE id = p_object_id;
      INSERT INTO knowledge_lifecycle_events (
        account_id, scope_kind, scope_workspace_id, scope_subject_id, scope_key,
        target_kind, object_id, event_type, old_state, new_state,
        old_generation, new_generation, operation_id, input_hash, reason_code,
        actor_kind, actor_subject_id, initiating_human_subject_id
      ) VALUES (
        p_account_id, object_row.scope_kind, object_row.scope_workspace_id,
        object_row.scope_subject_id, object_row.scope_key, 'object', p_object_id,
        'object_version_added', object_row.lifecycle_state, object_row.lifecycle_state,
        object_row.lifecycle_generation, object_row.lifecycle_generation,
        p_operation_id, p_input_hash, p_reason_code, p_actor_kind,
        p_actor_subject_id, p_initiating_human_subject_id
      );
      RETURN version_row.version_generation;
    END;
    $body$;
  $ddl$, data_schema);
END
$object_version_function$;

DO $revoke_public_function_access$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.scoped_knowledge_apply_lifecycle('
    || 'uuid,text,uuid,text,bigint,text,text,text,text,text,text) FROM PUBLIC',
    data_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.scoped_knowledge_advance_source_acl('
    || 'uuid,uuid,bigint,bigint,uuid,text,text,text,text,text,text) FROM PUBLIC',
    data_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.scoped_knowledge_complete_sync('
    || 'uuid,uuid,text,text,timestamptz,jsonb,text,text,text) FROM PUBLIC',
    data_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.scoped_knowledge_advance_object_version('
    || 'uuid,uuid,bigint,bigint,uuid,text,text,text,text,text,text) FROM PUBLIC',
    data_schema
  );
END
$revoke_public_function_access$;

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'knowledge_providers',
    'knowledge_sources',
    'knowledge_source_acl_versions',
    'knowledge_sync_runs',
    'knowledge_source_objects',
    'knowledge_document_versions',
    'knowledge_lifecycle_events',
    'knowledge_entities',
    'knowledge_entity_aliases',
    'knowledge_facts',
    'knowledge_claims',
    'knowledge_claim_relations',
    'knowledge_claim_evidence',
    'knowledge_claim_reviews',
    'knowledge_change_proposals'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY scoped_knowledge_select ON %I FOR SELECT '
      || 'USING (opengeni_private.scoped_knowledge_scope_visible('
      || 'account_id, scope_kind, scope_workspace_id, scope_subject_id))',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY scoped_knowledge_insert ON %I FOR INSERT '
      || 'WITH CHECK ('
      || 'opengeni_private.scoped_knowledge_scope_visible('
      || 'account_id, scope_kind, scope_workspace_id, scope_subject_id) '
      || 'AND opengeni_private.scoped_knowledge_actor_authorized('
      || 'actor_kind, actor_subject_id, initiating_human_subject_id))',
      table_name
    );
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'knowledge_providers',
    'knowledge_sources',
    'knowledge_sync_runs',
    'knowledge_source_objects'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY scoped_knowledge_update ON %I FOR UPDATE '
      || 'USING (opengeni_private.scoped_knowledge_scope_visible('
      || 'account_id, scope_kind, scope_workspace_id, scope_subject_id)) '
      || 'WITH CHECK (opengeni_private.scoped_knowledge_scope_visible('
      || 'account_id, scope_kind, scope_workspace_id, scope_subject_id))',
      table_name
    );
  END LOOP;
END
$rls$;

DO $runtime_grants$
DECLARE table_name text;
DECLARE data_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    FOREACH table_name IN ARRAY ARRAY[
      'knowledge_providers',
      'knowledge_sources',
      'knowledge_source_acl_versions',
      'knowledge_sync_runs',
      'knowledge_source_objects',
      'knowledge_document_versions',
      'knowledge_entities',
      'knowledge_entity_aliases',
      'knowledge_facts',
      'knowledge_claims',
      'knowledge_claim_relations',
      'knowledge_claim_evidence',
      'knowledge_claim_reviews',
      'knowledge_change_proposals'
    ] LOOP
      EXECUTE format('GRANT SELECT, INSERT ON TABLE %I.%I TO opengeni_app', data_schema, table_name);
    END LOOP;
    EXECUTE format(
      'GRANT SELECT ON TABLE %I.knowledge_lifecycle_events TO opengeni_app', data_schema
    );
    EXECUTE format(
      'GRANT USAGE, SELECT ON SEQUENCE %I.knowledge_claim_review_revision_seq TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.scoped_knowledge_apply_lifecycle('
      || 'uuid,text,uuid,text,bigint,text,text,text,text,text,text) TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.scoped_knowledge_advance_source_acl('
      || 'uuid,uuid,bigint,bigint,uuid,text,text,text,text,text,text) TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.scoped_knowledge_complete_sync('
      || 'uuid,uuid,text,text,timestamptz,jsonb,text,text,text) TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.scoped_knowledge_advance_object_version('
      || 'uuid,uuid,bigint,bigint,uuid,text,text,text,text,text,text) TO opengeni_app',
      data_schema
    );
  END IF;
END
$runtime_grants$;

RESET statement_timeout;
RESET lock_timeout;