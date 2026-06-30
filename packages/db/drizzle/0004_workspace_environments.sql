CREATE TABLE IF NOT EXISTS "workspace_environments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_environments_workspace_name_idx" ON "workspace_environments" ("workspace_id", "name");
CREATE INDEX IF NOT EXISTS "workspace_environments_workspace_created_idx" ON "workspace_environments" ("workspace_id", "created_at");
ALTER TABLE "workspace_environments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_environments" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'workspace_environments' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "workspace_environments";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "workspace_environments"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE TABLE IF NOT EXISTS "workspace_environment_variables" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "environment_id" uuid NOT NULL REFERENCES "workspace_environments"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "value_encrypted" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_environment_variables_env_name_idx" ON "workspace_environment_variables" ("workspace_id", "environment_id", "name");
CREATE INDEX IF NOT EXISTS "workspace_environment_variables_workspace_env_idx" ON "workspace_environment_variables" ("workspace_id", "environment_id");
ALTER TABLE "workspace_environment_variables" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_environment_variables" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'workspace_environment_variables' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "workspace_environment_variables";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "workspace_environment_variables"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "environment_id" uuid REFERENCES "workspace_environments"("id") ON DELETE SET NULL;
ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "environment_id" uuid REFERENCES "workspace_environments"("id") ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS "sessions_environment_idx" ON "sessions" ("workspace_id", "environment_id");
CREATE INDEX IF NOT EXISTS "scheduled_tasks_environment_idx" ON "scheduled_tasks" ("workspace_id", "environment_id");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
