CREATE TABLE IF NOT EXISTS "integration_oauth_clients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "issuer" text NOT NULL,
  "authorization_server" text NOT NULL,
  "client_id" text NOT NULL,
  "client_secret_encrypted" text,
  "token_endpoint_auth_method" text NOT NULL DEFAULT 'none',
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "integration_oauth_clients_metadata_object_chk"
    CHECK (jsonb_typeof("metadata") = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS "integration_oauth_clients_issuer_idx"
  ON "integration_oauth_clients" ("issuer");
CREATE INDEX IF NOT EXISTS "integration_oauth_clients_as_idx"
  ON "integration_oauth_clients" ("authorization_server");

CREATE TABLE IF NOT EXISTS "integration_oauth_state_nonces" (
  "nonce" text PRIMARY KEY NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "subject_id" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "integration_oauth_state_nonces_workspace_idx"
  ON "integration_oauth_state_nonces" ("workspace_id");
CREATE INDEX IF NOT EXISTS "integration_oauth_state_nonces_expires_idx"
  ON "integration_oauth_state_nonces" ("expires_at");

ALTER TABLE "integration_oauth_state_nonces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_oauth_state_nonces" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'integration_oauth_state_nonces' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "integration_oauth_state_nonces";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "integration_oauth_state_nonces"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "integration_oauth_clients" TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "integration_oauth_state_nonces" TO opengeni_app;
  END IF;
END $$;
