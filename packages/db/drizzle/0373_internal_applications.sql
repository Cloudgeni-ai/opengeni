-- deployment-mode: rolling
-- Governed internal application factory. Storage is installed independently
-- of the deployment feature flag; no route or worker reaches it while
-- OPENGENI_ADVANCED_DEPLOYMENTS_ENABLED is false.
-- Runtime privilege convergence is also pinned in packages/db/src/runtime-posture.ts.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE "internal_applications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "status" text NOT NULL DEFAULT 'draft',
  "head_revision_id" uuid,
  "head_revision" bigint NOT NULL DEFAULT 0,
  "definition_hash" text,
  "creation_operation_id" uuid NOT NULL,
  "creation_request_hash" text NOT NULL,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "internal_applications_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "internal_applications_status_chk" CHECK ("status" IN ('draft','active','archived')),
  CONSTRAINT "internal_applications_head_chk" CHECK (
    ("head_revision" = 0 AND "head_revision_id" IS NULL AND "definition_hash" IS NULL)
    OR ("head_revision" BETWEEN 1 AND 9007199254740991 AND "head_revision_id" IS NOT NULL
      AND "definition_hash" ~ '^sha256:[0-9a-f]{64}$')
  ),
  CONSTRAINT "internal_applications_text_chk" CHECK (
    octet_length(convert_to("slug", 'UTF8')) BETWEEN 1 AND 63
    AND "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    AND octet_length(convert_to("name", 'UTF8')) BETWEEN 1 AND 256
    AND octet_length(convert_to("description", 'UTF8')) <= 2048
    AND octet_length(convert_to("created_by_subject_id", 'UTF8')) BETWEEN 1 AND 1024
  )
);
CREATE UNIQUE INDEX "internal_applications_workspace_slug_uq" ON "internal_applications" ("workspace_id", "slug");
CREATE UNIQUE INDEX "internal_applications_workspace_operation_uq" ON "internal_applications" ("workspace_id", "creation_operation_id");
CREATE UNIQUE INDEX "internal_applications_scope_uq" ON "internal_applications" ("id", "workspace_id", "account_id");
CREATE INDEX "internal_applications_workspace_updated_idx" ON "internal_applications" ("workspace_id", "updated_at", "id");

CREATE TABLE "internal_application_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "application_id" uuid NOT NULL REFERENCES "internal_applications"("id") ON DELETE CASCADE,
  "operation_id" uuid NOT NULL,
  "request_hash" text NOT NULL,
  "revision" bigint NOT NULL,
  "definition_hash" text NOT NULL,
  "definition" jsonb NOT NULL,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "internal_application_revisions_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "internal_application_revisions_application_scope_fk" FOREIGN KEY ("application_id", "workspace_id", "account_id")
    REFERENCES "internal_applications"("id", "workspace_id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "internal_application_revisions_values_chk" CHECK (
    "revision" BETWEEN 1 AND 9007199254740991
    AND "request_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND "definition_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND jsonb_typeof("definition") = 'object'
  )
);
CREATE UNIQUE INDEX "internal_application_revisions_revision_uq" ON "internal_application_revisions" ("application_id", "revision");
CREATE UNIQUE INDEX "internal_application_revisions_operation_uq" ON "internal_application_revisions" ("application_id", "operation_id");
CREATE INDEX "internal_application_revisions_workspace_time_idx" ON "internal_application_revisions" ("workspace_id", "created_at", "id");
ALTER TABLE "internal_applications" ADD CONSTRAINT "internal_applications_head_revision_fk"
  FOREIGN KEY ("head_revision_id") REFERENCES "internal_application_revisions"("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "internal_application_data_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "kind" text NOT NULL,
  "allowed_access_modes" jsonb NOT NULL,
  "locator" jsonb NOT NULL,
  "schema_definition" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "governance" jsonb NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'active',
  "revision" bigint NOT NULL DEFAULT 1,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "internal_application_data_sources_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "internal_application_data_sources_values_chk" CHECK (
    "kind" IN ('postgres','s3','documents','vector','http_api','custom')
    AND "status" IN ('active','disabled') AND "revision" BETWEEN 1 AND 9007199254740991
    AND jsonb_typeof("allowed_access_modes") = 'array' AND jsonb_array_length("allowed_access_modes") BETWEEN 1 AND 3
    AND jsonb_typeof("locator") = 'object' AND "locator"->>'kind' = "kind"
    AND jsonb_typeof("schema_definition") = 'object' AND jsonb_typeof("governance") = 'object'
    AND jsonb_typeof("metadata") = 'object'
  )
);
CREATE UNIQUE INDEX "internal_application_data_sources_workspace_name_uq" ON "internal_application_data_sources" ("workspace_id", "name");
CREATE INDEX "internal_application_data_sources_workspace_status_idx" ON "internal_application_data_sources" ("workspace_id", "status", "name");

CREATE TABLE "internal_application_deployment_targets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "kind" text NOT NULL,
  "environment" text NOT NULL,
  "site" text NOT NULL,
  "config" jsonb NOT NULL,
  "capabilities" jsonb NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'active',
  "revision" bigint NOT NULL DEFAULT 1,
  "last_observed_at" timestamptz,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "internal_application_targets_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "internal_application_targets_values_chk" CHECK (
    "kind" IN ('kubernetes','connected_machine','managed')
    AND "environment" IN ('development','staging','production')
    AND "status" IN ('active','degraded','disabled')
    AND "revision" BETWEEN 1 AND 9007199254740991
    AND jsonb_typeof("config") = 'object' AND "config"->>'kind' = "kind"
    AND jsonb_typeof("capabilities") = 'object' AND jsonb_typeof("metadata") = 'object'
  )
);
CREATE UNIQUE INDEX "internal_application_targets_workspace_name_uq" ON "internal_application_deployment_targets" ("workspace_id", "name");
CREATE INDEX "internal_application_targets_workspace_status_idx" ON "internal_application_deployment_targets" ("workspace_id", "status", "name");

CREATE TABLE "internal_application_bundles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "application_id" uuid NOT NULL REFERENCES "internal_applications"("id") ON DELETE CASCADE,
  "application_revision_id" uuid NOT NULL REFERENCES "internal_application_revisions"("id") ON DELETE RESTRICT,
  "operation_id" uuid NOT NULL,
  "request_hash" text NOT NULL,
  "digest" text NOT NULL,
  "manifest" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'ready',
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "internal_application_bundles_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "internal_application_bundles_values_chk" CHECK (
    "request_hash" ~ '^sha256:[0-9a-f]{64}$' AND "digest" ~ '^sha256:[0-9a-f]{64}$'
    AND "status" IN ('ready','revoked') AND jsonb_typeof("manifest") = 'object'
  )
);
CREATE UNIQUE INDEX "internal_application_bundles_digest_uq" ON "internal_application_bundles" ("application_id", "digest");
CREATE UNIQUE INDEX "internal_application_bundles_operation_uq" ON "internal_application_bundles" ("application_id", "operation_id");
CREATE INDEX "internal_application_bundles_workspace_time_idx" ON "internal_application_bundles" ("workspace_id", "created_at", "id");

CREATE TABLE "internal_application_deployments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "application_id" uuid NOT NULL REFERENCES "internal_applications"("id") ON DELETE CASCADE,
  "environment" text NOT NULL,
  "target_id" uuid NOT NULL REFERENCES "internal_application_deployment_targets"("id") ON DELETE RESTRICT,
  "target_revision" bigint NOT NULL,
  "active_bundle_id" uuid REFERENCES "internal_application_bundles"("id") ON DELETE RESTRICT,
  "previous_bundle_id" uuid REFERENCES "internal_application_bundles"("id") ON DELETE RESTRICT,
  "desired_bundle_id" uuid REFERENCES "internal_application_bundles"("id") ON DELETE RESTRICT,
  "status" text NOT NULL DEFAULT 'not_deployed',
  "internal_url" text,
  "revision" bigint NOT NULL DEFAULT 1,
  "last_observed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "internal_application_deployments_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "internal_application_deployments_values_chk" CHECK (
    "environment" IN ('development','staging','production')
    AND "status" IN ('not_deployed','plan_ready','awaiting_approval','deploying','running','degraded','failed','rolling_back','rolled_back','retired')
    AND "target_revision" BETWEEN 1 AND 9007199254740991 AND "revision" BETWEEN 1 AND 9007199254740991
  )
);
CREATE UNIQUE INDEX "internal_application_deployments_environment_uq" ON "internal_application_deployments" ("application_id", "environment");
CREATE INDEX "internal_application_deployments_workspace_status_idx" ON "internal_application_deployments" ("workspace_id", "status", "updated_at");

CREATE TABLE "internal_application_deployment_operations" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "deployment_id" uuid NOT NULL REFERENCES "internal_application_deployments"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "status" text NOT NULL,
  "request_hash" text NOT NULL,
  "plan" jsonb,
  "approved_by_subject_id" text,
  "approved_at" timestamptz,
  "provider_operation_id" text,
  "provider_started" boolean NOT NULL DEFAULT false,
  "result" jsonb,
  "error_code" text,
  "error_message" text,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "internal_application_operations_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "internal_application_operations_values_chk" CHECK (
    "kind" IN ('plan','apply','observe','rollback','retire')
    AND "status" IN ('planned','awaiting_approval','approved','provider_started','outcome_unknown','observing','completed','failed','superseded')
    AND "request_hash" ~ '^sha256:[0-9a-f]{64}$'
    AND ("plan" IS NULL OR jsonb_typeof("plan") = 'object')
    AND ("result" IS NULL OR jsonb_typeof("result") = 'object')
    AND ("error_code" IS NULL OR octet_length(convert_to("error_code", 'UTF8')) BETWEEN 1 AND 128)
    AND ("error_message" IS NULL OR octet_length(convert_to("error_message", 'UTF8')) BETWEEN 1 AND 2048)
  )
);
CREATE INDEX "internal_application_operations_deployment_time_idx" ON "internal_application_deployment_operations" ("deployment_id", "created_at", "id");
CREATE INDEX "internal_application_operations_workspace_status_idx" ON "internal_application_deployment_operations" ("workspace_id", "status", "updated_at");

CREATE TABLE "internal_application_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "application_id" uuid REFERENCES "internal_applications"("id") ON DELETE CASCADE,
  "deployment_id" uuid REFERENCES "internal_application_deployments"("id") ON DELETE CASCADE,
  "operation_id" uuid REFERENCES "internal_application_deployment_operations"("id") ON DELETE SET NULL,
  "type" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "facts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "internal_application_events_workspace_account_fk" FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "internal_application_events_values_chk" CHECK (
    octet_length(convert_to("type", 'UTF8')) BETWEEN 1 AND 128
    AND octet_length(convert_to("actor_subject_id", 'UTF8')) BETWEEN 1 AND 1024
    AND jsonb_typeof("facts") = 'object'
  )
);
CREATE INDEX "internal_application_events_workspace_time_idx" ON "internal_application_events" ("workspace_id", "created_at", "id");
CREATE INDEX "internal_application_events_application_time_idx" ON "internal_application_events" ("application_id", "created_at", "id");

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'internal_applications', 'internal_application_revisions',
    'internal_application_data_sources', 'internal_application_deployment_targets',
    'internal_application_bundles', 'internal_application_deployments',
    'internal_application_deployment_operations', 'internal_application_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $rls$;

CREATE POLICY "workspace_isolation" ON "internal_applications"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY "workspace_isolation" ON "internal_application_data_sources"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY "workspace_isolation" ON "internal_application_deployment_targets"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY "workspace_isolation" ON "internal_application_deployments"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY "workspace_isolation" ON "internal_application_deployment_operations"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
-- Immutable evidence tables expose SELECT + INSERT only to the runtime role.
CREATE POLICY "workspace_select" ON "internal_application_revisions" FOR SELECT
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY "workspace_insert" ON "internal_application_revisions" FOR INSERT
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY "workspace_select" ON "internal_application_bundles" FOR SELECT
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY "workspace_insert" ON "internal_application_bundles" FOR INSERT
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY "workspace_select" ON "internal_application_events" FOR SELECT
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY "workspace_insert" ON "internal_application_events" FOR INSERT
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "internal_applications" TO opengeni_app;
    GRANT SELECT, INSERT ON "internal_application_revisions" TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "internal_application_data_sources" TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "internal_application_deployment_targets" TO opengeni_app;
    GRANT SELECT, INSERT ON "internal_application_bundles" TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "internal_application_deployments" TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "internal_application_deployment_operations" TO opengeni_app;
    GRANT SELECT, INSERT ON "internal_application_events" TO opengeni_app;
  END IF;
END $grants$;
