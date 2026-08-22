-- deployment-mode: rolling
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- The PR Review Pack is a provider-neutral adapter over the generic automation
-- substrate. App registrations own only provider action credentials; generic
-- automation sources own webhook authentication and generic triggers/runs own
-- event matching, idempotency, and ordinary-session dispatch.

CREATE TABLE "pr_review_app_registrations" (
  "id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "source_id" uuid NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "provider" text NOT NULL,
  "provider_base_url" text NOT NULL,
  "app_id" text,
  "credential_kind" text NOT NULL,
  "credential_encrypted" text,
  "access_token_expires_at" timestamptz,
  "webhook_auth_kind" text NOT NULL,
  "webhook_username" text,
  "status" text NOT NULL DEFAULT 'active',
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pr_review_app_registrations_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "pr_review_app_registrations_source_fk"
    FOREIGN KEY ("workspace_id", "source_id")
    REFERENCES "automation_sources"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "pr_review_app_registrations_provider_chk"
    CHECK ("provider" IN ('github', 'gitlab', 'azure_devops')),
  CONSTRAINT "pr_review_app_registrations_credential_chk" CHECK (
    ("provider" = 'github' AND "credential_kind" = 'github_app' AND "credential_encrypted" IS NOT NULL AND "app_id" IS NOT NULL)
    OR
    ("provider" IN ('gitlab', 'azure_devops') AND "credential_kind" = 'provider_token' AND "credential_encrypted" IS NOT NULL)
  ),
  CONSTRAINT "pr_review_app_registrations_webhook_auth_chk" CHECK (
    ("provider" = 'github' AND "webhook_auth_kind" = 'hmac_sha256')
    OR ("provider" = 'gitlab' AND "webhook_auth_kind" = 'shared_token')
    OR ("provider" = 'azure_devops' AND "webhook_auth_kind" = 'basic' AND "webhook_username" IS NOT NULL)
  ),
  CONSTRAINT "pr_review_app_registrations_status_chk"
    CHECK ("status" IN ('active', 'disabled'))
);
CREATE UNIQUE INDEX "pr_review_app_registrations_workspace_id_uq"
  ON "pr_review_app_registrations" ("workspace_id", "id");
CREATE UNIQUE INDEX "pr_review_app_registrations_workspace_id_provider_uq"
  ON "pr_review_app_registrations" ("workspace_id", "id", "provider");
CREATE UNIQUE INDEX "pr_review_app_registrations_workspace_provider_name_uq"
  ON "pr_review_app_registrations" ("workspace_id", "provider", "name");
CREATE INDEX "pr_review_app_registrations_workspace_status_idx"
  ON "pr_review_app_registrations" ("workspace_id", "status");
CREATE UNIQUE INDEX "pr_review_app_registrations_source_uq"
  ON "pr_review_app_registrations" ("source_id");

CREATE TABLE "pr_review_repository_bindings" (
  "id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "trigger_id" uuid NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "registration_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "repository_uri" text NOT NULL,
  "repository_full_name" text NOT NULL,
  "provider_repository_id" text NOT NULL,
  "installation_id" text,
  "project_id" text,
  "model" text,
  "additional_instructions" text,
  "status" text NOT NULL DEFAULT 'active',
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pr_review_repository_bindings_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "pr_review_repository_bindings_trigger_fk"
    FOREIGN KEY ("workspace_id", "trigger_id")
    REFERENCES "automation_triggers"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "pr_review_repository_bindings_registration_fk"
    FOREIGN KEY ("workspace_id", "registration_id", "provider")
    REFERENCES "pr_review_app_registrations"("workspace_id", "id", "provider") ON DELETE CASCADE,
  CONSTRAINT "pr_review_repository_bindings_provider_chk"
    CHECK ("provider" IN ('github', 'gitlab', 'azure_devops')),
  CONSTRAINT "pr_review_repository_bindings_status_chk"
    CHECK ("status" IN ('active', 'disabled'))
);
CREATE UNIQUE INDEX "pr_review_repository_bindings_workspace_id_uq"
  ON "pr_review_repository_bindings" ("workspace_id", "id");
CREATE UNIQUE INDEX "pr_review_repo_workspace_registration_provider_uq"
  ON "pr_review_repository_bindings" ("workspace_id", "id", "registration_id", "provider");
CREATE UNIQUE INDEX "pr_review_repository_bindings_registration_repo_uq"
  ON "pr_review_repository_bindings" ("registration_id", "provider_repository_id");
CREATE INDEX "pr_review_repository_bindings_workspace_status_idx"
  ON "pr_review_repository_bindings" ("workspace_id", "status");
CREATE UNIQUE INDEX "pr_review_repository_bindings_trigger_uq"
  ON "pr_review_repository_bindings" ("trigger_id");

ALTER TABLE "pr_review_app_registrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pr_review_app_registrations" FORCE ROW LEVEL SECURITY;
CREATE POLICY pr_review_app_registrations_tenant ON "pr_review_app_registrations"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

ALTER TABLE "pr_review_repository_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pr_review_repository_bindings" FORCE ROW LEVEL SECURITY;
CREATE POLICY pr_review_repository_bindings_tenant ON "pr_review_repository_bindings"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
