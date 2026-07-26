CREATE TABLE IF NOT EXISTS "workspace_packs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "pack_id" text NOT NULL,
  "manifest" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_packs_workspace_pack_idx" ON "workspace_packs" ("workspace_id", "pack_id");
ALTER TABLE "workspace_packs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_packs" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'workspace_packs' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "workspace_packs";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "workspace_packs"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
