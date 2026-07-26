-- deployment-mode: rolling

ALTER TABLE "github_installations"
  ADD COLUMN IF NOT EXISTS "repository_scope" text NOT NULL DEFAULT 'all';
ALTER TABLE "github_installations"
  ADD COLUMN IF NOT EXISTS "linked_by_subject_id" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'github_installations_repository_scope_check'
      AND conrelid = 'github_installations'::regclass
  ) THEN
    ALTER TABLE "github_installations"
      ADD CONSTRAINT "github_installations_repository_scope_check"
      CHECK ("repository_scope" IN ('all', 'selected'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "github_installation_repositories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "installation_id" integer NOT NULL,
  "repository_id" bigint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'github_installation_repositories_workspace_account_fk'
      AND conrelid = 'github_installation_repositories'::regclass
  ) THEN
    ALTER TABLE "github_installation_repositories"
      ADD CONSTRAINT "github_installation_repositories_workspace_account_fk"
      FOREIGN KEY ("workspace_id", "account_id")
      REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'github_installation_repositories_installation_fk'
      AND conrelid = 'github_installation_repositories'::regclass
  ) THEN
    ALTER TABLE "github_installation_repositories"
      ADD CONSTRAINT "github_installation_repositories_installation_fk"
      FOREIGN KEY ("workspace_id", "installation_id")
      REFERENCES "github_installations"("workspace_id", "installation_id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "github_install_repo_workspace_installation_repo_idx"
  ON "github_installation_repositories" ("workspace_id", "installation_id", "repository_id");
CREATE INDEX IF NOT EXISTS "github_install_repo_workspace_installation_idx"
  ON "github_installation_repositories" ("workspace_id", "installation_id");

ALTER TABLE "github_installation_repositories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "github_installation_repositories" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'github_installation_repositories'
      AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "github_installation_repositories";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "github_installation_repositories"
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
