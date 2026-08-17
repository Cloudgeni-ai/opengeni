-- deployment-mode: rolling
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- OpenGeni Lens is a provider-neutral pull-request review trigger. App
-- registrations own encrypted webhook/provider credentials, repository
-- bindings select the exact provider resource, and delivery rows are the
-- durable idempotency journal between an authenticated webhook and an ordinary
-- OpenGeni session.

CREATE TABLE "lens_app_registrations" (
  "id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
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
  "webhook_secret_encrypted" text NOT NULL,
  "webhook_username" text,
  "status" text NOT NULL DEFAULT 'active',
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lens_app_registrations_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "lens_app_registrations_provider_chk"
    CHECK ("provider" IN ('github', 'gitlab', 'azure_devops')),
  CONSTRAINT "lens_app_registrations_credential_chk" CHECK (
    ("provider" = 'github' AND "credential_kind" = 'github_app' AND "credential_encrypted" IS NOT NULL AND "app_id" IS NOT NULL)
    OR
    ("provider" IN ('gitlab', 'azure_devops') AND "credential_kind" = 'provider_token' AND "credential_encrypted" IS NOT NULL)
  ),
  CONSTRAINT "lens_app_registrations_webhook_auth_chk" CHECK (
    ("provider" = 'github' AND "webhook_auth_kind" = 'hmac_sha256')
    OR ("provider" = 'gitlab' AND "webhook_auth_kind" = 'shared_token')
    OR ("provider" = 'azure_devops' AND "webhook_auth_kind" = 'basic' AND "webhook_username" IS NOT NULL)
  ),
  CONSTRAINT "lens_app_registrations_status_chk"
    CHECK ("status" IN ('active', 'disabled'))
);
CREATE UNIQUE INDEX "lens_app_registrations_workspace_id_uq"
  ON "lens_app_registrations" ("workspace_id", "id");
CREATE UNIQUE INDEX "lens_app_registrations_workspace_id_provider_uq"
  ON "lens_app_registrations" ("workspace_id", "id", "provider");
CREATE UNIQUE INDEX "lens_app_registrations_workspace_provider_name_uq"
  ON "lens_app_registrations" ("workspace_id", "provider", "name");
CREATE INDEX "lens_app_registrations_workspace_status_idx"
  ON "lens_app_registrations" ("workspace_id", "status");

CREATE TABLE "lens_repository_bindings" (
  "id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
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
  CONSTRAINT "lens_repository_bindings_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "lens_repository_bindings_registration_fk"
    FOREIGN KEY ("workspace_id", "registration_id", "provider")
    REFERENCES "lens_app_registrations"("workspace_id", "id", "provider") ON DELETE CASCADE,
  CONSTRAINT "lens_repository_bindings_provider_chk"
    CHECK ("provider" IN ('github', 'gitlab', 'azure_devops')),
  CONSTRAINT "lens_repository_bindings_status_chk"
    CHECK ("status" IN ('active', 'disabled'))
);
CREATE UNIQUE INDEX "lens_repository_bindings_workspace_id_uq"
  ON "lens_repository_bindings" ("workspace_id", "id");
CREATE UNIQUE INDEX "lens_repository_bindings_workspace_id_registration_provider_uq"
  ON "lens_repository_bindings" ("workspace_id", "id", "registration_id", "provider");
CREATE UNIQUE INDEX "lens_repository_bindings_registration_repo_uq"
  ON "lens_repository_bindings" ("registration_id", "provider_repository_id");
CREATE INDEX "lens_repository_bindings_workspace_status_idx"
  ON "lens_repository_bindings" ("workspace_id", "status");

CREATE TABLE "lens_webhook_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "registration_id" uuid NOT NULL,
  "repository_binding_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "delivery_key" text NOT NULL,
  "request_digest" text NOT NULL,
  "event_name" text NOT NULL,
  "action" text,
  "pull_request_id" text,
  "head_sha" text,
  "base_sha" text,
  "status" text NOT NULL DEFAULT 'pending',
  "ignored_reason" text,
  "error_code" text,
  "session_id" uuid REFERENCES "sessions"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lens_webhook_deliveries_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "lens_webhook_deliveries_registration_fk"
    FOREIGN KEY ("workspace_id", "registration_id", "provider")
    REFERENCES "lens_app_registrations"("workspace_id", "id", "provider") ON DELETE CASCADE,
  CONSTRAINT "lens_webhook_deliveries_repository_binding_fk"
    FOREIGN KEY ("workspace_id", "repository_binding_id", "registration_id", "provider")
    REFERENCES "lens_repository_bindings"("workspace_id", "id", "registration_id", "provider") ON DELETE CASCADE,
  CONSTRAINT "lens_webhook_deliveries_provider_chk"
    CHECK ("provider" IN ('github', 'gitlab', 'azure_devops')),
  CONSTRAINT "lens_webhook_deliveries_status_chk"
    CHECK ("status" IN ('pending', 'dispatched', 'ignored', 'failed')),
  CONSTRAINT "lens_webhook_deliveries_digest_chk"
    CHECK ("request_digest" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "lens_webhook_deliveries_registration_delivery_uq"
  ON "lens_webhook_deliveries" ("registration_id", "delivery_key");
CREATE INDEX "lens_webhook_deliveries_workspace_status_idx"
  ON "lens_webhook_deliveries" ("workspace_id", "status", "created_at");

ALTER TABLE "lens_app_registrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lens_app_registrations" FORCE ROW LEVEL SECURITY;
CREATE POLICY lens_app_registrations_tenant ON "lens_app_registrations"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

ALTER TABLE "lens_repository_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lens_repository_bindings" FORCE ROW LEVEL SECURITY;
CREATE POLICY lens_repository_bindings_tenant ON "lens_repository_bindings"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

ALTER TABLE "lens_webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lens_webhook_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY lens_webhook_deliveries_tenant ON "lens_webhook_deliveries"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY session_visibility_isolation
  ON "lens_webhook_deliveries" AS RESTRICTIVE
  FOR ALL
  USING (session_reference_visible("account_id", "workspace_id", "session_id"))
  WITH CHECK (session_reference_visible("account_id", "workspace_id", "session_id"));
