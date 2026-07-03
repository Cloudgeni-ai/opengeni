CREATE TABLE IF NOT EXISTS "connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "subject_id" text,
  "provider_domain" text NOT NULL,
  "kind" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "credential_encrypted" text NOT NULL,
  "granted_scopes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "expires_at" timestamptz,
  "last_refresh_at" timestamptz,
  "last_used_at" timestamptz,
  "last_error" text,
  "version" integer NOT NULL DEFAULT 1,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_by_subject_id" text,
  "updated_by_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "connections_kind_chk"
    CHECK ("kind" IN ('oauth2', 'api_key', 'app_install', 'delegated')),
  CONSTRAINT "connections_status_chk"
    CHECK ("status" IN ('active', 'needs_reauth', 'revoked', 'error')),
  CONSTRAINT "connections_granted_scopes_array_chk"
    CHECK (jsonb_typeof("granted_scopes") = 'array'),
  CONSTRAINT "connections_metadata_object_chk"
    CHECK (jsonb_typeof("metadata") = 'object'),
  CONSTRAINT "connections_version_positive_chk"
    CHECK ("version" > 0)
);

CREATE INDEX IF NOT EXISTS "connections_workspace_provider_status_idx"
  ON "connections" ("workspace_id", "provider_domain", "status");
CREATE INDEX IF NOT EXISTS "connections_workspace_subject_provider_idx"
  ON "connections" ("workspace_id", "subject_id", "provider_domain");
CREATE INDEX IF NOT EXISTS "connections_workspace_kind_idx"
  ON "connections" ("workspace_id", "kind");
CREATE INDEX IF NOT EXISTS "connections_workspace_expires_idx"
  ON "connections" ("workspace_id", "expires_at");

ALTER TABLE "connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "connections" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'connections' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "connections";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "connections"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "connections" TO opengeni_app;
  END IF;
END $$;
