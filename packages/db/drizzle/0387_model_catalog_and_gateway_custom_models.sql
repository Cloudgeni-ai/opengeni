-- deployment-mode: maintenance
-- Migration 0387: deployment-owned model catalog authority, provider-scoped
-- workspace Vercel AI Gateway/OpenRouter slugs, and indexed pre-catalog prompt
-- receipt replay.
-- This changes the exact runtime-posture table/grant contract. Stop every API,
-- control worker, and turn worker before applying it, and never restart a
-- pre-0387 image after commit.

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
      '0383 model catalog activation requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0383 model catalog activation received a malformed application database role list'
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
      '0383 model catalog activation received an invalid application database role list'
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
      '0383 model catalog activation requires all configured OpenGeni application database sessions to be stopped'
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
  provider_kind text NOT NULL,
  upstream_model_id text NOT NULL,
  label text,
  version integer NOT NULL DEFAULT 1,
  create_operation_id uuid NOT NULL,
  create_request_hash text NOT NULL,
  delete_operation_id uuid,
  delete_request_hash text,
  created_by_subject_id text NOT NULL,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspace_gateway_custom_models_workspace_account_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT workspace_gateway_custom_models_provider_kind_chk CHECK (
    provider_kind IN ('vercel_gateway', 'openrouter')
  ),
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
  ),
  CONSTRAINT workspace_gateway_custom_models_version_chk CHECK (version > 0),
  CONSTRAINT workspace_gateway_custom_models_create_hash_chk CHECK (
    create_request_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT workspace_gateway_custom_models_delete_receipt_chk CHECK (
    (delete_operation_id IS NULL AND delete_request_hash IS NULL)
    OR (
      delete_operation_id IS NOT NULL
      AND delete_request_hash ~ '^[a-f0-9]{64}$'
      AND retired_at IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX workspace_gateway_custom_models_workspace_upstream_uq
  ON workspace_gateway_custom_models (workspace_id, provider_kind, upstream_model_id)
  WHERE retired_at IS NULL;

CREATE UNIQUE INDEX workspace_gateway_custom_models_create_operation_uq
  ON workspace_gateway_custom_models (workspace_id, provider_kind, create_operation_id);

CREATE UNIQUE INDEX workspace_gateway_custom_models_delete_operation_uq
  ON workspace_gateway_custom_models (workspace_id, provider_kind, delete_operation_id)
  WHERE delete_operation_id IS NOT NULL;

-- New Send/Steer receipts persist one parsed boundary-request fingerprint and
-- replay it before mutable model-catalog resolution. Legacy receipt identity
-- remains unchanged; this partial index keeps the actor/key compatibility
-- probe bounded even when the prior action or target session differs.
CREATE INDEX session_command_receipts_prompt_actor_operation_idx
  ON session_command_receipts (
    workspace_id,
    actor_type,
    actor_subject_id,
    actor_attempt_id,
    operation_key
  )
  WHERE action IN ('prompt.send', 'prompt.steer');

ALTER TABLE workspace_gateway_custom_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_gateway_custom_models FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON workspace_gateway_custom_models
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

-- Migration 0040 registers owner default privileges for the historical
-- opengeni_app role. Rotated-role deployments must not inherit that stale
-- grant on these new tables, and host defaults may name other obsolete
-- application roles. Strip every explicit non-owner table grantee. The
-- migration_application_roles list above is drain detection only; the
-- post-migration role provisioner grants only the deployment's current target
-- runtime role.
DO $model_catalog_table_acl_reset$
DECLARE
  data_schema text := pg_catalog.current_schema();
  relation_name text;
  role_name text;
BEGIN
  FOR relation_name IN
    SELECT relation.value
    FROM pg_catalog.unnest(
      ARRAY[
        'deployment_model_catalog',
        'workspace_gateway_custom_models'
      ]::text[]
    ) AS relation(value)
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON TABLE %I.%I FROM PUBLIC',
      data_schema,
      relation_name
    );
    FOR role_name IN
      SELECT grantee_role.rolname
      FROM pg_catalog.pg_class relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        coalesce(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) privilege
      INNER JOIN pg_catalog.pg_roles grantee_role
        ON grantee_role.oid = privilege.grantee
      WHERE relation.oid = pg_catalog.to_regclass(
          pg_catalog.format('%I.%I', data_schema, relation_name)
        )
        AND privilege.grantee <> 0
        AND privilege.grantee <> relation.relowner
      GROUP BY grantee_role.rolname
      ORDER BY grantee_role.rolname COLLATE "C"
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON TABLE %I.%I FROM %I',
        data_schema,
        relation_name,
        role_name
      );
    END LOOP;
  END LOOP;
END
$model_catalog_table_acl_reset$;

COMMENT ON TABLE workspace_gateway_custom_models IS
  'Workspace-owned Vercel AI Gateway and OpenRouter upstream slugs. Retired rows remain execution evidence; capabilities and billing are never stored here.';

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
      '0383 model catalog activation observed a configured OpenGeni application database session after schema installation'
      USING ERRCODE = '55000';
  END IF;
END
$model_catalog_runtime_drain_after$;
