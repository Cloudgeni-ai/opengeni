-- Rename workspace secret Environments to Variable Sets.
-- Keeps data in place; public compatibility aliases live in API/contracts/SDK.

ALTER TABLE IF EXISTS "workspace_environments" RENAME TO "workspace_variable_sets";
ALTER TABLE IF EXISTS "workspace_environment_variables" RENAME TO "workspace_variable_set_variables";

ALTER TABLE IF EXISTS "workspace_variable_set_variables" RENAME COLUMN "environment_id" TO "variable_set_id";
ALTER TABLE IF EXISTS "sessions" RENAME COLUMN "environment_id" TO "variable_set_id";
ALTER TABLE IF EXISTS "scheduled_tasks" RENAME COLUMN "environment_id" TO "variable_set_id";

ALTER INDEX IF EXISTS "workspace_environments_workspace_name_idx" RENAME TO "workspace_variable_sets_workspace_name_idx";
ALTER INDEX IF EXISTS "workspace_environments_workspace_created_idx" RENAME TO "workspace_variable_sets_workspace_created_idx";
ALTER INDEX IF EXISTS "workspace_environment_variables_env_name_idx" RENAME TO "workspace_variable_set_variables_env_name_idx";
ALTER INDEX IF EXISTS "workspace_environment_variables_workspace_env_idx" RENAME TO "workspace_variable_set_variables_workspace_env_idx";
ALTER INDEX IF EXISTS "sessions_environment_idx" RENAME TO "sessions_variable_set_idx";
ALTER INDEX IF EXISTS "scheduled_tasks_environment_idx" RENAME TO "scheduled_tasks_variable_set_idx";

ALTER TABLE "workspace_variable_sets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_variable_sets" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'workspace_variable_sets' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "workspace_variable_sets";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "workspace_variable_sets"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE "workspace_variable_set_variables" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_variable_set_variables" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'workspace_variable_set_variables' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "workspace_variable_set_variables";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "workspace_variable_set_variables"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO opengeni_app',
      current_schema()
    );
  END IF;
END $$;
