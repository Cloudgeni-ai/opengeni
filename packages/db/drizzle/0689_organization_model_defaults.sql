-- deployment-mode: rolling
-- Organization model defaults: one row per organization with the default
-- model for new work, the model allowlist for workspaces that have no policy
-- of their own, and automatic-compaction triggers by exact model id. Every
-- workspace follows these until it saves its own value; nothing here is a
-- ceiling over a workspace's own choice. Old releases never read the table.
--
-- A workspace policy row now means "this workspace chose its own allowlist",
-- so a row that allows everything ({NULL, NULL}) is removed: it already read
-- exactly like no row, and without it the workspace follows the
-- organization. Rows that restrict anything are kept as workspace choices.
SET LOCAL lock_timeout = '5s';

CREATE TABLE "organization_model_defaults" (
  "account_id" uuid PRIMARY KEY REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "session_defaults" jsonb,
  "allowed_providers" text[],
  "allowed_models" text[],
  "model_compaction_thresholds" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_by_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_model_defaults_session_defaults_check" CHECK (
    "session_defaults" IS NULL OR jsonb_typeof("session_defaults") = 'object'
  ),
  CONSTRAINT "organization_model_defaults_compaction_check" CHECK (
    jsonb_typeof("model_compaction_thresholds") = 'object'
  ),
  CONSTRAINT "organization_model_defaults_allowlist_bounds_check" CHECK (
    coalesce(cardinality("allowed_providers"), 0) <= 64
    AND coalesce(cardinality("allowed_models"), 0) <= 256
  )
);

ALTER TABLE "organization_model_defaults" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_model_defaults" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "organization_model_defaults" FROM PUBLIC;
-- Every workspace in the organization reads its organization's row; writes
-- additionally pass the organization-administrator check in the application
-- data layer before they reach this table.
CREATE POLICY organization_model_defaults_account ON "organization_model_defaults"
  USING ("account_id" = opengeni_private.current_account_id())
  WITH CHECK ("account_id" = opengeni_private.current_account_id());

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.organization_model_defaults TO opengeni_app',
      target_schema
    );
  END IF;
END
$grants$;

-- Owner-only posture window: the table is FORCE RLS and the migration
-- principal sets no tenant GUC.
ALTER TABLE "workspace_model_policies" NO FORCE ROW LEVEL SECURITY;
DELETE FROM "workspace_model_policies"
WHERE "allowed_providers" IS NULL AND "allowed_models" IS NULL;
ALTER TABLE "workspace_model_policies" FORCE ROW LEVEL SECURITY;
