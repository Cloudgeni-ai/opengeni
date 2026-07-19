-- deployment-mode: rolling
-- OPE-41: secret-free, generation-fenced authorization bindings for platform
-- Git credentials used by existing checkouts in durable managed sandboxes.

CREATE TABLE IF NOT EXISTS "sandbox_git_credential_bindings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "source" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "repository_refs" jsonb NOT NULL,
  "generation" integer NOT NULL DEFAULT 1,
  "reason_code" text,
  "last_validated_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sandbox_git_credential_bindings_provider_check"
    CHECK ("provider" IN ('github', 'gitlab', 'azure_devops')),
  CONSTRAINT "sandbox_git_credential_bindings_source_check"
    CHECK ("source" IN ('explicit_resource', 'observed_checkout')),
  CONSTRAINT "sandbox_git_credential_bindings_status_check"
    CHECK ("status" IN ('active', 'rebind_required', 'revoked', 'unavailable')),
  CONSTRAINT "sandbox_git_credential_bindings_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "sandbox_git_credential_bindings_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "sandbox_git_credential_bindings_repository_refs_check"
    CHECK (jsonb_typeof("repository_refs") = 'array' AND jsonb_array_length("repository_refs") > 0),
  CONSTRAINT "sandbox_git_credential_bindings_generation_check" CHECK ("generation" > 0),
  CONSTRAINT "sandbox_git_credential_bindings_reason_code_check"
    CHECK ("reason_code" IS NULL OR "reason_code" ~ '^[a-z0-9_]{1,64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_git_credential_bindings_session_provider_idx"
  ON "sandbox_git_credential_bindings" ("workspace_id", "session_id", "provider");
CREATE INDEX IF NOT EXISTS "sandbox_git_credential_bindings_workspace_idx"
  ON "sandbox_git_credential_bindings" ("workspace_id", "updated_at");

ALTER TABLE "sandbox_git_credential_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sandbox_git_credential_bindings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "sandbox_git_credential_bindings";
CREATE POLICY workspace_isolation ON "sandbox_git_credential_bindings"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO opengeni_app',
      current_schema(),
      'sandbox_git_credential_bindings'
    );
  END IF;
END $$;