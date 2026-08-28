-- deployment-mode: maintenance
-- Migration 0369: deployment-owned model catalog authority plus workspace
-- custom Vercel AI Gateway slugs.
-- This changes the exact runtime-posture table/grant contract. Stop every API,
-- control worker, and turn worker before applying it, and never restart a
-- pre-0369 image after commit.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $model_catalog_runtime_drain_before$
DECLARE
  configured_roles_text text := nullif(
    current_setting('opengeni.migration_application_roles', true), ''
  );
  configured_roles jsonb;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION
      '0369 model catalog activation requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0369 model catalog activation received a malformed application database role list'
      USING ERRCODE = '55000';
  END;
  IF jsonb_typeof(configured_roles) <> 'array'
    OR jsonb_array_length(configured_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(configured_roles) AS roles(value)
      WHERE jsonb_typeof(value) <> 'string'
        OR btrim(value #>> '{}') = ''
        OR octet_length(value #>> '{}') > 63
    )
    OR (
      SELECT count(*) FROM jsonb_array_elements_text(configured_roles)
    ) <> (
      SELECT count(DISTINCT value)
      FROM jsonb_array_elements_text(configured_roles) AS roles(value)
    )
  THEN
    RAISE EXCEPTION
      '0369 model catalog activation received an invalid application database role list'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0369 model catalog activation requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$model_catalog_runtime_drain_before$;

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
    octet_length(upstream_model_id) BETWEEN 1 AND 238
    AND upstream_model_id ~ '^[!-~]+$'
    AND upstream_model_id !~ '[|]'
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

DO $model_catalog_runtime_drain_after$
DECLARE
  configured_roles jsonb := current_setting(
    'opengeni.migration_application_roles', false
  )::jsonb;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0369 model catalog activation observed a configured OpenGeni application database session after schema installation'
      USING ERRCODE = '55000';
  END IF;
END
$model_catalog_runtime_drain_after$;
