-- deployment-mode: maintenance
-- Add provider-neutral deterministic knowledge-source actions to shared
-- Schedules. This is one cutover because pre-0197 control workers route every
-- schedule through session/model/billing dispatch, and the document identity
-- indexes below require bounded exclusive locks. Stop every API/control/turn
-- worker before activation and never restart an older image after commit.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';

-- Reject mixed old/new application writers before waiting on the cutover
-- locks. Repeat after the locks to close the connect-before-lock race.
DO $knowledge_source_sync_maintenance_preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'knowledge source sync activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$knowledge_source_sync_maintenance_preflight$;

LOCK TABLE "scheduled_tasks" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "scheduled_task_runs" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "documents" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "knowledge_document_versions" IN ACCESS EXCLUSIVE MODE;

DO $knowledge_source_sync_maintenance_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'knowledge source sync activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$knowledge_source_sync_maintenance_guard$;

ALTER TABLE "scheduled_tasks"
  ADD COLUMN IF NOT EXISTS "action" jsonb NOT NULL DEFAULT '{"kind":"agent_turn"}'::jsonb;

UPDATE "scheduled_tasks"
SET "action" = '{"kind":"agent_turn"}'::jsonb
WHERE "action" IS NULL OR jsonb_typeof("action") <> 'object' OR "action"->>'kind' IS NULL;

ALTER TABLE "scheduled_tasks"
  ADD CONSTRAINT "scheduled_tasks_action_chk" CHECK (
    jsonb_typeof("action") = 'object'
    AND "action"->>'kind' IN ('agent_turn', 'knowledge_source_sync')
    AND octet_length(convert_to("action"::text, 'UTF8')) <= 32768
    AND (
      "action"->>'kind' = 'agent_turn'
      OR (
        "run_mode" = 'new_session_per_run'
        AND "reusable_session_id" IS NULL
        AND "variable_set_id" IS NULL
        AND "rig_id" IS NULL
        AND "overlap_policy" IN ('skip', 'buffer_one')
      )
    )
  ) NOT VALID;

ALTER TABLE "scheduled_tasks" VALIDATE CONSTRAINT "scheduled_tasks_action_chk";

ALTER TABLE "scheduled_task_runs"
  ADD COLUMN IF NOT EXISTS "action_kind" text NOT NULL DEFAULT 'agent_turn',
  ADD COLUMN IF NOT EXISTS "knowledge_sync_run_id" uuid,
  ADD COLUMN IF NOT EXISTS "knowledge_summary" jsonb,
  ADD COLUMN IF NOT EXISTS "completed_at" timestamptz;

ALTER TABLE "scheduled_task_runs"
  ADD CONSTRAINT "scheduled_task_runs_action_chk" CHECK (
    "action_kind" IN ('agent_turn', 'knowledge_source_sync')
    AND ("knowledge_summary" IS NULL OR (
      jsonb_typeof("knowledge_summary") = 'object'
      AND octet_length(convert_to("knowledge_summary"::text, 'UTF8')) <= 16384
    ))
  ) NOT VALID;

ALTER TABLE "scheduled_task_runs" VALIDATE CONSTRAINT "scheduled_task_runs_action_chk";

-- Content-addressed files may be shared by multiple provider objects. Preserve
-- the legacy per-base file uniqueness only for ordinary documents, and give
-- connector documents an independent immutable source-object/version key.
ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "knowledge_source_identity" text;

DROP INDEX IF EXISTS "documents_workspace_base_file_idx";

CREATE UNIQUE INDEX "documents_workspace_base_file_idx"
  ON "documents" ("workspace_id", "base_id", "file_id")
  WHERE "knowledge_source_identity" IS NULL;

CREATE UNIQUE INDEX "documents_workspace_knowledge_source_identity_uq"
  ON "documents" ("workspace_id", "knowledge_source_identity")
  WHERE "knowledge_source_identity" IS NOT NULL;

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_knowledge_source_identity_chk" CHECK (
    "knowledge_source_identity" IS NULL
    OR length(btrim("knowledge_source_identity")) BETWEEN 1 AND 512
  ) NOT VALID;

ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_knowledge_source_identity_chk";

-- Provider revisions identify provider observations, not immutable OpenGeni
-- observations. Metadata/ACL-only observations may legitimately share bytes
-- and provider revision while retaining a distinct ingestion identity.
ALTER TABLE "knowledge_document_versions"
  DROP CONSTRAINT IF EXISTS "knowledge_document_versions_object_external_version_uq";
CREATE INDEX IF NOT EXISTS "knowledge_document_versions_object_external_version_idx"
  ON "knowledge_document_versions" ("object_id", "external_version_id");

ALTER TABLE "scheduled_task_runs"
  ADD CONSTRAINT "scheduled_task_runs_knowledge_sync_fk"
  FOREIGN KEY ("knowledge_sync_run_id") REFERENCES "knowledge_sync_runs"("id") ON DELETE SET NULL NOT VALID;

ALTER TABLE "scheduled_task_runs"
  VALIDATE CONSTRAINT "scheduled_task_runs_knowledge_sync_fk";

CREATE INDEX IF NOT EXISTS "scheduled_task_runs_knowledge_sync_idx"
  ON "scheduled_task_runs" ("workspace_id", "knowledge_sync_run_id")
  WHERE "knowledge_sync_run_id" IS NOT NULL;

CREATE TABLE "knowledge_source_sync_states" (
  "source_id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "scheduled_task_id" uuid NOT NULL,
  "source_sync_generation" bigint NOT NULL,
  "source_lifecycle_generation" bigint NOT NULL,
  "source_config_generation" bigint NOT NULL,
  "control_workspace_id" uuid NOT NULL,
  "provider_coordination_key" text NOT NULL,
  "connection_id" uuid NOT NULL,
  "connection_version" bigint NOT NULL,
  "connection_provider_domain" text NOT NULL,
  "connection_kind" text NOT NULL,
  "connection_owner_subject_id" text NOT NULL,
  "initiating_subject_id" text NOT NULL,
  "destination" jsonb NOT NULL,
  "execution_checkpoint" jsonb,
  "execution_checkpoint_generation" bigint NOT NULL DEFAULT 0,
  "active_scan_generation" bigint NOT NULL DEFAULT 0,
  "provider_cursor" jsonb,
  "wake_revision" bigint NOT NULL DEFAULT 0,
  "pending_wake_count" integer NOT NULL DEFAULT 0,
  "lease_id" uuid,
  "lease_until" timestamptz,
  "buffered_wake" boolean NOT NULL DEFAULT false,
  "buffered_scheduled_task_run_id" uuid,
  "reconnect_required" boolean NOT NULL DEFAULT false,
  "last_success_at" timestamptz,
  "last_completed_at" timestamptz,
  "last_summary" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_source_sync_states_source_fk"
    FOREIGN KEY ("source_id") REFERENCES "knowledge_sources"("id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_source_sync_states_workspace_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_source_sync_states_task_fk"
    FOREIGN KEY ("scheduled_task_id") REFERENCES "scheduled_tasks"("id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_source_sync_states_buffered_run_fk"
    FOREIGN KEY ("buffered_scheduled_task_run_id") REFERENCES "scheduled_task_runs"("id") ON DELETE SET NULL,
  CONSTRAINT "knowledge_source_sync_states_task_uq" UNIQUE ("scheduled_task_id"),
  CONSTRAINT "knowledge_source_sync_states_authority_chk" CHECK (
    "source_sync_generation" >= 0
    AND "source_lifecycle_generation" > 0
    AND "source_config_generation" > 0
    AND "control_workspace_id" = "workspace_id"
    AND length(btrim("provider_coordination_key")) BETWEEN 1 AND 1024
    AND "connection_version" > 0
    AND length(btrim("connection_provider_domain")) BETWEEN 1 AND 2048
    AND "connection_kind" IN ('oauth2', 'api_key', 'app_install', 'delegated')
    AND length(btrim("connection_owner_subject_id")) BETWEEN 1 AND 1024
    AND length(btrim("initiating_subject_id")) BETWEEN 1 AND 1024
    AND jsonb_typeof("destination") = 'object'
    AND ("execution_checkpoint" IS NULL OR (
      jsonb_typeof("execution_checkpoint") = 'object'
      AND octet_length(convert_to("execution_checkpoint"::text, 'UTF8')) <= 2097152
    ))
    AND "execution_checkpoint_generation" >= 0
    AND "active_scan_generation" >= 0
    AND ("provider_cursor" IS NULL OR (
      jsonb_typeof("provider_cursor") = 'object'
      AND octet_length(convert_to("provider_cursor"::text, 'UTF8')) <= 1048576
    ))
    AND "wake_revision" >= 0
    AND "pending_wake_count" >= 0
    AND (("lease_id" IS NULL AND "lease_until" IS NULL)
      OR ("lease_id" IS NOT NULL AND "lease_until" IS NOT NULL))
    AND (("buffered_wake" = true AND "buffered_scheduled_task_run_id" IS NOT NULL)
      OR ("buffered_wake" = false AND "buffered_scheduled_task_run_id" IS NULL))
    AND ("last_summary" IS NULL OR (
      jsonb_typeof("last_summary") = 'object'
      AND octet_length(convert_to("last_summary"::text, 'UTF8')) <= 16384
    ))
  )
);

CREATE TABLE "knowledge_source_sync_object_observations" (
  "source_id" uuid NOT NULL,
  "external_object_id" text NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "scheduled_task_run_id" uuid,
  "scan_generation" bigint NOT NULL,
  "provider_revision" text,
  "metadata_hash" text,
  "observed_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_source_sync_object_observations_identity_uq"
    UNIQUE ("source_id", "external_object_id"),
  CONSTRAINT "knowledge_source_sync_object_observations_source_fk"
    FOREIGN KEY ("source_id") REFERENCES "knowledge_sources"("id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_source_sync_object_observations_workspace_fk"
    FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_source_sync_object_observations_run_fk"
    FOREIGN KEY ("scheduled_task_run_id") REFERENCES "scheduled_task_runs"("id") ON DELETE SET NULL,
  CONSTRAINT "knowledge_source_sync_object_observations_bounds_chk" CHECK (
    length(btrim("external_object_id")) BETWEEN 1 AND 1024
    AND "scan_generation" > 0
    AND ("provider_revision" IS NULL OR length("provider_revision") BETWEEN 1 AND 1024)
    AND ("metadata_hash" IS NULL OR "metadata_hash" ~ '^[0-9a-f]{64}$')
  )
);

CREATE INDEX "knowledge_source_sync_object_observations_scan_idx"
  ON "knowledge_source_sync_object_observations" ("workspace_id", "source_id", "scan_generation");

CREATE INDEX "knowledge_source_sync_states_due_idx"
  ON "knowledge_source_sync_states" ("workspace_id", "buffered_wake", "lease_until", "updated_at");

CREATE TABLE "knowledge_source_sync_item_outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "scheduled_task_run_id" uuid NOT NULL,
  "knowledge_sync_run_id" uuid,
  "source_id" uuid NOT NULL,
  "source_config_generation" bigint NOT NULL,
  "source_lifecycle_generation" bigint NOT NULL,
  "external_object_id" text NOT NULL,
  "provider_revision" text,
  "metadata_hash" text,
  "acl_eligibility" text NOT NULL DEFAULT 'pending',
  "acl_evidence" jsonb,
  "index_obligation_id" uuid,
  "outcome" text NOT NULL,
  "reason_code" text,
  "detail" text,
  "content_sha256" text,
  "size_bytes" bigint,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_source_sync_item_outcomes_task_run_fk"
    FOREIGN KEY ("scheduled_task_run_id") REFERENCES "scheduled_task_runs"("id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_source_sync_item_outcomes_sync_run_fk"
    FOREIGN KEY ("knowledge_sync_run_id") REFERENCES "knowledge_sync_runs"("id") ON DELETE SET NULL,
  CONSTRAINT "knowledge_source_sync_item_outcomes_source_fk"
    FOREIGN KEY ("source_id") REFERENCES "knowledge_sources"("id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_source_sync_item_outcomes_workspace_fk"
    FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_source_sync_item_outcomes_identity_uq"
    UNIQUE ("scheduled_task_run_id", "external_object_id"),
  CONSTRAINT "knowledge_source_sync_item_outcomes_bounds_chk" CHECK (
    length(btrim("external_object_id")) BETWEEN 1 AND 1024
    AND "source_config_generation" > 0
    AND "source_lifecycle_generation" > 0
    AND "outcome" IN ('imported', 'unchanged', 'skipped', 'failed', 'tombstoned')
    AND ("provider_revision" IS NULL OR length("provider_revision") BETWEEN 1 AND 1024)
    AND ("metadata_hash" IS NULL OR "metadata_hash" ~ '^[0-9a-f]{64}$')
    AND "acl_eligibility" IN ('pending', 'eligible', 'denied')
    AND ("acl_evidence" IS NULL OR (
      jsonb_typeof("acl_evidence") = 'object'
      AND octet_length(convert_to("acl_evidence"::text, 'UTF8')) <= 16384
    ))
    AND ("reason_code" IS NULL OR length(btrim("reason_code")) BETWEEN 1 AND 128)
    AND ("detail" IS NULL OR length("detail") <= 1000)
    AND ("content_sha256" IS NULL OR "content_sha256" ~ '^[0-9a-f]{64}$')
    AND ("size_bytes" IS NULL OR "size_bytes" >= 0)
  )
);

CREATE INDEX "knowledge_source_sync_item_outcomes_run_idx"
  ON "knowledge_source_sync_item_outcomes" ("workspace_id", "scheduled_task_run_id", "created_at");

CREATE TABLE "knowledge_source_sync_wakes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "source_id" uuid NOT NULL,
  "scheduled_task_id" uuid NOT NULL,
  "scheduled_task_run_id" uuid NOT NULL,
  "cause" text NOT NULL,
  "producer_key" text NOT NULL,
  "source_config_generation" bigint NOT NULL,
  "source_lifecycle_generation" bigint NOT NULL,
  "coalesced" boolean NOT NULL DEFAULT false,
  "claimed_at" timestamptz,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_source_sync_wakes_workspace_fk"
    FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_source_sync_wakes_source_fk"
    FOREIGN KEY ("source_id") REFERENCES "knowledge_sources"("id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_source_sync_wakes_task_fk"
    FOREIGN KEY ("scheduled_task_id") REFERENCES "scheduled_tasks"("id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_source_sync_wakes_run_fk"
    FOREIGN KEY ("scheduled_task_run_id") REFERENCES "scheduled_task_runs"("id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_source_sync_wakes_run_uq" UNIQUE ("scheduled_task_run_id"),
  CONSTRAINT "knowledge_source_sync_wakes_bounds_chk" CHECK (
    "cause" IN ('scheduled', 'manual', 'initial', 'provider_event', 'retry', 'repair')
    AND length(btrim("producer_key")) BETWEEN 1 AND 1024
    AND "source_config_generation" > 0
    AND "source_lifecycle_generation" > 0
    AND ("completed_at" IS NULL OR "claimed_at" IS NOT NULL)
  )
);

CREATE INDEX "knowledge_source_sync_wakes_pending_idx"
  ON "knowledge_source_sync_wakes" ("workspace_id", "source_id", "completed_at", "created_at");

CREATE TABLE "knowledge_source_sync_index_obligations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "scheduled_task_run_id" uuid,
  "source_id" uuid NOT NULL,
  "source_sync_generation" bigint NOT NULL,
  "initiating_subject_id" text NOT NULL,
  "external_object_id" text NOT NULL,
  "knowledge_source_object_id" uuid NOT NULL,
  "knowledge_document_version_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "source_config_generation" bigint NOT NULL,
  "source_lifecycle_generation" bigint NOT NULL,
  "object_lifecycle_generation" bigint NOT NULL,
  "object_version_generation" bigint NOT NULL,
  "citation_locator" jsonb NOT NULL,
  "acl_eligibility" text NOT NULL DEFAULT 'pending',
  "status" text NOT NULL DEFAULT 'pending',
  "failure_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_source_sync_index_obligations_workspace_fk"
    FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_source_sync_index_obligations_run_fk"
    FOREIGN KEY ("scheduled_task_run_id") REFERENCES "scheduled_task_runs"("id") ON DELETE SET NULL,
  CONSTRAINT "knowledge_source_sync_index_obligations_source_fk"
    FOREIGN KEY ("source_id") REFERENCES "knowledge_sources"("id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_source_sync_index_obligations_object_fk"
    FOREIGN KEY ("knowledge_source_object_id") REFERENCES "knowledge_source_objects"("id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_source_sync_index_obligations_version_fk"
    FOREIGN KEY ("knowledge_document_version_id") REFERENCES "knowledge_document_versions"("id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_source_sync_index_obligations_document_fk"
    FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE,
  CONSTRAINT "knowledge_source_sync_index_obligations_version_uq" UNIQUE ("knowledge_document_version_id"),
  CONSTRAINT "knowledge_source_sync_index_obligations_bounds_chk" CHECK (
    length(btrim("external_object_id")) BETWEEN 1 AND 1024
    AND "source_sync_generation" >= 0
    AND length(btrim("initiating_subject_id")) BETWEEN 1 AND 1024
    AND "source_config_generation" > 0
    AND "source_lifecycle_generation" > 0
    AND "object_lifecycle_generation" > 0
    AND "object_version_generation" > 0
    AND jsonb_typeof("citation_locator") = 'object'
    AND octet_length(convert_to("citation_locator"::text, 'UTF8')) <= 16384
    AND "acl_eligibility" IN ('pending', 'eligible', 'denied')
    AND "status" IN ('pending', 'indexed', 'failed', 'invalidated')
    AND ("failure_code" IS NULL OR length(btrim("failure_code")) BETWEEN 1 AND 128)
  )
);

ALTER TABLE "knowledge_source_sync_item_outcomes"
  ADD CONSTRAINT "knowledge_source_sync_item_outcomes_index_obligation_fk"
  FOREIGN KEY ("index_obligation_id") REFERENCES "knowledge_source_sync_index_obligations"("id") ON DELETE SET NULL;

CREATE INDEX "knowledge_source_sync_index_obligations_pending_idx"
  ON "knowledge_source_sync_index_obligations" ("workspace_id", "status", "created_at");

-- Runtime code needs row locks on the mutable source/object heads without
-- granting direct UPDATE on the scoped-knowledge tables. The helper observes
-- the existing account/workspace/subject RLS GUCs and follows the same
-- object-then-source order as scoped_knowledge_advance_object_version.
DO $knowledge_source_sync_lock_authority$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.knowledge_source_sync_lock_authority(
      p_account_id uuid,
      p_source_id uuid,
      p_object_id uuid
    ) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE object_found boolean := false;
    DECLARE source_found boolean := false;
    BEGIN
      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
        RAISE EXCEPTION 'knowledge source sync account authority is invalid'
          USING ERRCODE = '42501';
      END IF;
      IF p_object_id IS NOT NULL THEN
        SELECT true INTO object_found
        FROM knowledge_source_objects object_row
        WHERE object_row.account_id = p_account_id
          AND object_row.id = p_object_id
          AND object_row.source_id = p_source_id
          AND opengeni_private.scoped_knowledge_scope_visible(
            object_row.account_id,
            object_row.scope_kind,
            object_row.scope_workspace_id,
            object_row.scope_subject_id
          )
        FOR UPDATE;
        IF NOT coalesce(object_found, false) THEN
          RAISE EXCEPTION 'knowledge source sync object authority was not found'
            USING ERRCODE = 'P0002';
        END IF;
      END IF;
      SELECT true INTO source_found
      FROM knowledge_sources source_row
      WHERE source_row.account_id = p_account_id
        AND source_row.id = p_source_id
        AND opengeni_private.scoped_knowledge_scope_visible(
          source_row.account_id,
          source_row.scope_kind,
          source_row.scope_workspace_id,
          source_row.scope_subject_id
        )
      FOR UPDATE;
      IF NOT coalesce(source_found, false) THEN
        RAISE EXCEPTION 'knowledge source sync source authority was not found'
          USING ERRCODE = 'P0002';
      END IF;
    END;
    $body$;
  $ddl$, data_schema);
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.knowledge_source_sync_lock_authority(uuid,uuid,uuid) FROM PUBLIC',
    data_schema
  );
END
$knowledge_source_sync_lock_authority$;

ALTER TABLE "knowledge_source_sync_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_source_sync_states" FORCE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_source_sync_item_outcomes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_source_sync_item_outcomes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_source_sync_wakes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_source_sync_wakes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_source_sync_index_obligations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_source_sync_index_obligations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_source_sync_object_observations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_source_sync_object_observations" FORCE ROW LEVEL SECURITY;

CREATE POLICY "knowledge_source_sync_states_workspace_isolation"
  ON "knowledge_source_sync_states"
  USING ("account_id" = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND "workspace_id" = nullif(current_setting('opengeni.workspace_id', true), '')::uuid)
  WITH CHECK ("account_id" = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND "workspace_id" = nullif(current_setting('opengeni.workspace_id', true), '')::uuid);

CREATE POLICY "knowledge_source_sync_item_outcomes_workspace_isolation"
  ON "knowledge_source_sync_item_outcomes"
  USING ("account_id" = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND "workspace_id" = nullif(current_setting('opengeni.workspace_id', true), '')::uuid)
  WITH CHECK ("account_id" = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND "workspace_id" = nullif(current_setting('opengeni.workspace_id', true), '')::uuid);

CREATE POLICY "knowledge_source_sync_wakes_workspace_isolation"
  ON "knowledge_source_sync_wakes"
  USING ("account_id" = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND "workspace_id" = nullif(current_setting('opengeni.workspace_id', true), '')::uuid)
  WITH CHECK ("account_id" = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND "workspace_id" = nullif(current_setting('opengeni.workspace_id', true), '')::uuid);

CREATE POLICY "knowledge_source_sync_index_obligations_workspace_isolation"
  ON "knowledge_source_sync_index_obligations"
  USING ("account_id" = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND "workspace_id" = nullif(current_setting('opengeni.workspace_id', true), '')::uuid)
  WITH CHECK ("account_id" = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND "workspace_id" = nullif(current_setting('opengeni.workspace_id', true), '')::uuid);

CREATE POLICY "knowledge_source_sync_object_observations_workspace_isolation"
  ON "knowledge_source_sync_object_observations"
  USING ("account_id" = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND "workspace_id" = nullif(current_setting('opengeni.workspace_id', true), '')::uuid)
  WITH CHECK ("account_id" = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND "workspace_id" = nullif(current_setting('opengeni.workspace_id', true), '')::uuid);

DO $runtime_grants$
DECLARE data_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "knowledge_source_sync_states" TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "knowledge_source_sync_item_outcomes" TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "knowledge_source_sync_wakes" TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "knowledge_source_sync_index_obligations" TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "knowledge_source_sync_object_observations" TO opengeni_app;
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.knowledge_source_sync_lock_authority(uuid,uuid,uuid) TO opengeni_app',
      data_schema
    );
  END IF;
END
$runtime_grants$;
