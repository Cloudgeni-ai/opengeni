-- deployment-mode: rolling
-- Migration 0365: deployment-owned model catalog authority plus workspace
-- custom Vercel AI Gateway slugs.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Exactly one deployment-global, secret-free catalog document. Ordinary API
-- and worker roles may only read it; the operator upsert command uses a
-- migration/admin credential. No seed or boot-time rewrite is intentional.
CREATE TABLE deployment_model_catalog (
  singleton boolean PRIMARY KEY DEFAULT true,
  document jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT deployment_model_catalog_singleton_chk CHECK (singleton),
  CONSTRAINT deployment_model_catalog_document_chk CHECK (jsonb_typeof(document) = 'object'),
  CONSTRAINT deployment_model_catalog_version_chk CHECK (version > 0)
);

COMMENT ON TABLE deployment_model_catalog IS
  'Deployment-global, secret-free model catalog singleton. Runtime is SELECT-only; operators update it explicitly.';

CREATE TABLE workspace_gateway_custom_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  upstream_model_id text NOT NULL,
  label text,
  created_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspace_gateway_custom_models_workspace_account_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT workspace_gateway_custom_models_upstream_chk CHECK (
    upstream_model_id ~ '^[!-~]{1,256}$'
  ),
  CONSTRAINT workspace_gateway_custom_models_label_chk CHECK (
    label IS NULL OR (
      octet_length(label) BETWEEN 1 AND 128
      AND label !~ '[\r\n|]'
    )
  ),
  CONSTRAINT workspace_gateway_custom_models_actor_chk CHECK (
    octet_length(created_by_subject_id) BETWEEN 1 AND 1024
  )
);

CREATE UNIQUE INDEX workspace_gateway_custom_models_workspace_upstream_uq
  ON workspace_gateway_custom_models (workspace_id, upstream_model_id);

ALTER TABLE workspace_gateway_custom_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_gateway_custom_models FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON workspace_gateway_custom_models
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $grants$
DECLARE data_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT ON TABLE %I.deployment_model_catalog TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.workspace_gateway_custom_models TO opengeni_app',
      data_schema
    );
  END IF;
END
$grants$;

COMMENT ON TABLE workspace_gateway_custom_models IS
  'Workspace-owned unpinned Vercel AI Gateway upstream slugs. Capabilities and billing are never stored here.';