-- deployment-mode: maintenance
-- Stop every old/new API, control worker and turn worker; provide the exact
-- application login list for drain detection. Provision runtime roles after
-- commit and start only this release. Never restart pre-0599 binaries: their
-- live key fences ignore selected workspace scope and explicit permissions.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $drain$
DECLARE
  roles jsonb;
BEGIN
  BEGIN
    roles := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'organization API key policy migration requires a valid application role list' USING ERRCODE = '55000';
  END;
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION 'organization API key policy migration requires an application role list' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}') OR octet_length(item #>> '{}') > 63)
    OR (SELECT count(*) FROM jsonb_array_elements_text(roles)) <>
       (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(roles))
    OR EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
      WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION 'organization API key policy migration requires stopped application roles' USING ERRCODE = '55000';
  END IF;
END $drain$;

-- Defaults preserve exact stored legacy permissions. No permission backfill.
ALTER TABLE api_keys
  ADD COLUMN workspace_scope text NOT NULL DEFAULT 'all',
  ADD COLUMN permission_mode text NOT NULL DEFAULT 'legacy',
  ADD CONSTRAINT api_keys_access_policy_check CHECK (
    workspace_scope IN ('all', 'selected') AND permission_mode IN ('legacy', 'explicit')
    AND (workspace_scope = 'all' OR (credential_kind = 'organization' AND permission_mode = 'explicit'))
    AND (permission_mode = 'legacy' OR credential_kind = 'organization')
  );
CREATE UNIQUE INDEX api_keys_id_account_idx ON api_keys(id, account_id);

CREATE TABLE organization_api_key_workspaces (
  api_key_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  PRIMARY KEY (api_key_id, workspace_id),
  CONSTRAINT organization_api_key_workspaces_key_account_fk FOREIGN KEY (api_key_id, account_id)
    REFERENCES api_keys(id, account_id) ON DELETE CASCADE,
  CONSTRAINT organization_api_key_workspaces_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
CREATE INDEX organization_api_key_workspaces_workspace_idx ON organization_api_key_workspaces(workspace_id, account_id);
ALTER TABLE organization_api_key_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_api_key_workspaces FORCE ROW LEVEL SECURITY;

-- Hash authentication must establish the proven account as well as present the
-- exact hash; it cannot enumerate sibling scopes even in that same account.
CREATE POLICY organization_api_key_workspaces_read ON organization_api_key_workspaces FOR SELECT
  USING (
    account_id = opengeni_private.current_account_id()
    AND (opengeni_private.current_api_key_hash() IS NULL OR EXISTS (
      SELECT 1 FROM api_keys k WHERE k.id = api_key_id AND k.account_id = organization_api_key_workspaces.account_id
        AND k.key_hash = opengeni_private.current_api_key_hash()
    ))
  );
CREATE POLICY organization_api_key_workspaces_write ON organization_api_key_workspaces FOR ALL
  USING (account_id = opengeni_private.current_account_id() AND opengeni_private.current_api_key_hash() IS NULL)
  WITH CHECK (account_id = opengeni_private.current_account_id() AND opengeni_private.current_api_key_hash() IS NULL);

-- Strip defaults/inherited direct ACLs; provisioning grants only the exact
-- current application role, never the drain-detection role list.
REVOKE ALL ON organization_api_key_workspaces FROM PUBLIC;
DO $acl$
DECLARE grant_row record;
BEGIN
  FOR grant_row IN
    SELECT DISTINCT acl.grantee, pg_catalog.pg_get_userbyid(acl.grantee) AS role_name
    FROM pg_catalog.pg_class relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))) acl
    WHERE relation.oid = 'organization_api_key_workspaces'::regclass
      AND acl.grantee <> 0 AND acl.grantee <> relation.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE organization_api_key_workspaces FROM %I', grant_row.role_name);
  END LOOP;
END $acl$;

