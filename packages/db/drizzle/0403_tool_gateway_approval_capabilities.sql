-- deployment-mode: maintenance
-- Current-human HTTP tool calls use hash-only, single-use approval capabilities
-- instead of trusting a caller-provided approval boolean.
-- This changes the exact runtime-posture table/grant/RLS contract. Stop every
-- API, control worker, and turn worker before applying it, and never restart a
-- pre-0403 image after commit.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $tool_gateway_approval_runtime_drain_before$
DECLARE
  configured_roles_text text := nullif(
    current_setting('opengeni.migration_application_roles', true), ''
  );
  configured_roles jsonb;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION
      '0403 tool gateway approval activation requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0403 tool gateway approval activation received a malformed application database role list'
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
      '0403 tool gateway approval activation received an invalid application database role list'
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
      '0403 tool gateway approval activation requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$tool_gateway_approval_runtime_drain_before$;

CREATE TABLE "tool_gateway_approval_capabilities" (
  "token_hash" text PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "subject_id" text NOT NULL,
  "operation_id" uuid NOT NULL,
  "catalog_digest" text NOT NULL,
  "server_id" text NOT NULL,
  "tool_name" text NOT NULL,
  "arguments_digest" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tool_gateway_approval_capabilities_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "tool_gateway_approval_capabilities_token_hash_chk"
    CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "tool_gateway_approval_capabilities_catalog_digest_chk"
    CHECK ("catalog_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "tool_gateway_approval_capabilities_arguments_digest_chk"
    CHECK ("arguments_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "tool_gateway_approval_capabilities_subject_chk"
    CHECK (length(btrim("subject_id")) BETWEEN 1 AND 1024),
  CONSTRAINT "tool_gateway_approval_capabilities_identity_chk"
    CHECK (
      length("server_id") BETWEEN 1 AND 256
      AND length("tool_name") BETWEEN 1 AND 512
    ),
  CONSTRAINT "tool_gateway_approval_capabilities_expiry_chk"
    CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '10 minutes')
);

CREATE UNIQUE INDEX "tool_gateway_approval_capabilities_operation_uq"
  ON "tool_gateway_approval_capabilities" ("workspace_id", "subject_id", "operation_id");
CREATE INDEX "tool_gateway_approval_capabilities_expires_idx"
  ON "tool_gateway_approval_capabilities" ("expires_at", "token_hash");

ALTER TABLE "tool_gateway_approval_capabilities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tool_gateway_approval_capabilities" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_subject_isolation" ON "tool_gateway_approval_capabilities"
  USING (
    opengeni_private.workspace_rls_visible("account_id", "workspace_id")
    AND "subject_id" = opengeni_private.current_subject_id()
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible("account_id", "workspace_id")
    AND "subject_id" = opengeni_private.current_subject_id()
  );

REVOKE ALL ON "tool_gateway_approval_capabilities" FROM PUBLIC;

-- The application role list is drain detection only. Remove any explicit ACL
-- inherited from owner default privileges, including an old side of a runtime
-- role rotation. The post-migration role provisioner grants only the exact
-- current target application role.
DO $tool_gateway_approval_table_acl_reset$
DECLARE
  data_schema text := pg_catalog.current_schema();
  role_name text;
BEGIN
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON TABLE %I.tool_gateway_approval_capabilities FROM PUBLIC',
    data_schema
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
        pg_catalog.format('%I.tool_gateway_approval_capabilities', data_schema)
      )
      AND privilege.grantee <> 0
      AND privilege.grantee <> relation.relowner
    GROUP BY grantee_role.rolname
    ORDER BY grantee_role.rolname COLLATE "C"
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON TABLE %I.tool_gateway_approval_capabilities FROM %I',
      data_schema,
      role_name
    );
  END LOOP;
END
$tool_gateway_approval_table_acl_reset$;

DO $tool_gateway_approval_runtime_drain_after$
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
      '0403 tool gateway approval activation observed a configured OpenGeni application database session after schema installation'
      USING ERRCODE = '55000';
  END IF;
END
$tool_gateway_approval_runtime_drain_after$;