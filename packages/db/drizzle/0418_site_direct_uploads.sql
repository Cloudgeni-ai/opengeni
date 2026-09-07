-- deployment-mode: maintenance
-- Sites publish signed uploads with optional source and no content hashes.
-- This changes the exact runtime-posture table/grant/RLS contract. Stop every
-- API, control worker, and turn worker before applying it, and never restart a
-- pre-0418 image after commit.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $site_direct_uploads_runtime_drain_before$
DECLARE
  configured_roles_text text := nullif(
    current_setting('opengeni.migration_application_roles', true), ''
  );
  configured_roles jsonb;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION
      '0418 site direct uploads requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0418 site direct uploads received a malformed application database role list'
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
      '0418 site direct uploads received an invalid application database role list'
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
      '0418 site direct uploads requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$site_direct_uploads_runtime_drain_before$;

ALTER TABLE workspace_artifact_versions DROP CONSTRAINT workspace_artifact_versions_content_chk;
ALTER TABLE workspace_artifact_events ADD COLUMN request_input jsonb;
ALTER TABLE workspace_artifact_versions ALTER COLUMN content_sha256 DROP NOT NULL;
ALTER TABLE workspace_artifact_versions ALTER COLUMN size_bytes TYPE bigint;
ALTER TABLE workspace_artifact_versions ALTER COLUMN source_size_bytes TYPE bigint;
ALTER TABLE workspace_artifact_versions ADD CONSTRAINT workspace_artifact_versions_content_chk CHECK (
  content_type = 'text/html' AND size_bytes > 0 AND length(content_key) BETWEEN 1 AND 1024
  AND ((source_key IS NULL AND source_size_bytes IS NULL) OR
       (source_key IS NOT NULL AND source_size_bytes > 0 AND length(source_key) BETWEEN 1 AND 1024))
  AND jsonb_typeof(requested_tools) = 'array' AND jsonb_array_length(requested_tools) <= 128
);
CREATE TABLE workspace_artifact_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','expired')),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
CREATE INDEX workspace_artifact_uploads_expiry_idx ON workspace_artifact_uploads(workspace_id, expires_at) WHERE status <> 'published';
ALTER TABLE workspace_artifact_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_artifact_uploads FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON workspace_artifact_uploads
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
REVOKE ALL ON "workspace_artifact_uploads" FROM PUBLIC;

-- The application role list is drain detection only. Remove any explicit ACL
-- inherited from owner default privileges, including an old side of a runtime
-- role rotation. The post-migration role provisioner grants only the exact
-- current target application role.
DO $site_direct_uploads_table_acl_reset$
DECLARE
  data_schema text := pg_catalog.current_schema();
  role_name text;
BEGIN
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON TABLE %I.workspace_artifact_uploads FROM PUBLIC',
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
        pg_catalog.format('%I.workspace_artifact_uploads', data_schema)
      )
      AND privilege.grantee <> 0
      AND privilege.grantee <> relation.relowner
    GROUP BY grantee_role.rolname
    ORDER BY grantee_role.rolname COLLATE "C"
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON TABLE %I.workspace_artifact_uploads FROM %I',
      data_schema,
      role_name
    );
  END LOOP;
END
$site_direct_uploads_table_acl_reset$;

DO $site_direct_uploads_runtime_drain_after$
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
      '0418 site direct uploads observed a configured OpenGeni application database session after schema installation'
      USING ERRCODE = '55000';
  END IF;
END
$site_direct_uploads_runtime_drain_after$;
