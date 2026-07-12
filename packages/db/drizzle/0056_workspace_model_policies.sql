-- Per-workspace model/provider availability policy: the HARD blocker deciding
-- which providers/models may serve a turn in a workspace at all. NULL columns =
-- unrestricted (exactly today's behavior; no row is ever required). A non-null
-- allowed_providers is a strict allowlist over resolved provider identities
-- (the built-in OpenAI/Azure client — including the legacy null-resolution
-- fallback — maps to one well-known id); allowed_models is an additional exact
-- model-id allowlist. Enforced at the API model choke points (422) and
-- authoritatively in the worker after turn model resolution, so a
-- codex-subscription workspace can be fail-closed to codex: a blocked turn
-- waits or fails loud, it never falls through to the paid built-in provider.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE TABLE IF NOT EXISTS "workspace_model_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "allowed_providers" text[],
  "allowed_models" text[],
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_model_policies_workspace_idx"
  ON "workspace_model_policies" ("workspace_id");

-- RLS — verbatim pattern from 0028_codex_multi_account.sql (codex_rotation_settings).
ALTER TABLE "workspace_model_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_model_policies" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'workspace_model_policies' AND policyname = 'workspace_isolation') THEN
    DROP POLICY workspace_isolation ON "workspace_model_policies";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "workspace_model_policies"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

-- Re-grant (verbatim from 0028/0024): new tables are not covered by prior grants.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
