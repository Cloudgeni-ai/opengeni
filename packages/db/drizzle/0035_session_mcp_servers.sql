CREATE TABLE IF NOT EXISTS "session_mcp_servers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "server_id" text NOT NULL,
  "name" text,
  "url" text NOT NULL,
  "allowed_tools" jsonb,
  "timeout_ms" integer,
  "cache_tools_list" boolean NOT NULL DEFAULT false,
  "headers_encrypted" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "credential_version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "session_mcp_servers_allowed_tools_array_chk"
    CHECK ("allowed_tools" IS NULL OR jsonb_typeof("allowed_tools") = 'array'),
  CONSTRAINT "session_mcp_servers_headers_object_chk"
    CHECK (jsonb_typeof("headers_encrypted") = 'object'),
  CONSTRAINT "session_mcp_servers_timeout_positive_chk"
    CHECK ("timeout_ms" IS NULL OR "timeout_ms" > 0),
  CONSTRAINT "session_mcp_servers_credential_version_positive_chk"
    CHECK ("credential_version" > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "session_mcp_servers_session_server_idx"
  ON "session_mcp_servers" ("workspace_id", "session_id", "server_id");
CREATE INDEX IF NOT EXISTS "session_mcp_servers_session_idx"
  ON "session_mcp_servers" ("workspace_id", "session_id");

ALTER TABLE "session_mcp_servers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_mcp_servers" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'session_mcp_servers' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "session_mcp_servers";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "session_mcp_servers"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
