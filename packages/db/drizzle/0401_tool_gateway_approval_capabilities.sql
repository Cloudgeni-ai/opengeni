-- deployment-mode: rolling
-- Current-human HTTP and Site tool calls use hash-only, single-use approval
-- capabilities instead of trusting a caller-provided approval boolean.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

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
  "site_version_id" uuid,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tool_gateway_approval_capabilities_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "tool_gateway_approval_capabilities_site_version_fk"
    FOREIGN KEY ("workspace_id", "site_version_id")
    REFERENCES "workspace_artifact_versions"("workspace_id", "id") ON DELETE CASCADE,
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

DO $application_grants$
DECLARE
  data_schema text := current_schema();
  application_role text;
BEGIN
  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
    UNION SELECT 'opengeni_app'
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.tool_gateway_approval_capabilities TO %I',
      data_schema, application_role
    );
  END LOOP;
END
$application_grants$;