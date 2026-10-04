-- deployment-mode: maintenance
-- Service accounts: an organization identity with no person behind it. Every
-- organization API key belongs to one; existing keys each get their own
-- (named after the key, role admin, so nothing loses access). Stop every
-- old/new API, control worker and turn worker; provide the exact application
-- login list for drain detection. Provision runtime roles after commit and
-- start only this release: older binaries create keys without an owner.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $drain$
DECLARE
  roles jsonb;
BEGIN
  BEGIN
    roles := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'service account migration requires a valid application role list' USING ERRCODE = '55000';
  END;
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION 'service account migration requires an application role list' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}') OR octet_length(item #>> '{}') > 63)
    OR (SELECT count(*) FROM jsonb_array_elements_text(roles)) <>
       (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(roles))
    OR EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
      WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION 'service account migration requires stopped application roles' USING ERRCODE = '55000';
  END IF;
END $drain$;

CREATE TABLE organization_service_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  role text NOT NULL DEFAULT 'admin',
  created_by_subject_id text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Up to admin, never owner: a service account can't own the organization.
  CONSTRAINT organization_service_accounts_role_check CHECK (role IN ('admin', 'member')),
  CONSTRAINT organization_service_accounts_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT organization_service_accounts_description_check
    CHECK (description IS NULL OR length(description) BETWEEN 1 AND 500),
  CONSTRAINT organization_service_accounts_creator_check
    CHECK (created_by_subject_id IS NULL OR length(btrim(created_by_subject_id)) BETWEEN 1 AND 1024)
);
CREATE UNIQUE INDEX organization_service_accounts_id_account_idx
  ON organization_service_accounts(id, account_id);
CREATE INDEX organization_service_accounts_account_idx
  ON organization_service_accounts(account_id, created_at) WHERE deleted_at IS NULL;
ALTER TABLE organization_service_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_service_accounts FORCE ROW LEVEL SECURITY;

-- Managed in the organization's own context; a key-hash lookup never reads them.
CREATE POLICY organization_service_accounts_isolation ON organization_service_accounts FOR ALL
  USING (account_id = opengeni_private.current_account_id() AND opengeni_private.current_api_key_hash() IS NULL)
  WITH CHECK (account_id = opengeni_private.current_account_id() AND opengeni_private.current_api_key_hash() IS NULL);

ALTER TABLE api_keys
  ADD COLUMN service_account_id uuid,
  ADD CONSTRAINT api_keys_service_account_fk FOREIGN KEY (service_account_id, account_id)
    REFERENCES organization_service_accounts(id, account_id) ON DELETE RESTRICT,
  ADD CONSTRAINT api_keys_service_account_kind_check
    CHECK (service_account_id IS NULL OR credential_kind = 'organization');
CREATE INDEX api_keys_service_account_idx ON api_keys(service_account_id)
  WHERE service_account_id IS NOT NULL;

-- Each existing organization key becomes its own service account. Keys that
-- were already revoked get a deleted one, so the list shows only live identities.
ALTER TABLE api_keys NO FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_service_accounts NO FORCE ROW LEVEL SECURITY;
CREATE TEMPORARY TABLE organization_service_account_backfill ON COMMIT DROP AS
  SELECT k.id AS api_key_id, gen_random_uuid() AS service_account_id, k.account_id,
    coalesce(nullif(left(btrim(k.name), 200), ''), 'Organization API key') AS name,
    k.description, k.revoked_at, k.created_at
  FROM api_keys k
  WHERE k.credential_kind = 'organization' AND k.service_account_id IS NULL;
INSERT INTO organization_service_accounts (
  id, account_id, name, description, role, deleted_at, created_at, updated_at
)
SELECT service_account_id, account_id, name, description, 'admin', revoked_at, created_at, created_at
FROM organization_service_account_backfill;
UPDATE api_keys k SET service_account_id = b.service_account_id
FROM organization_service_account_backfill b
WHERE k.id = b.api_key_id;
ALTER TABLE organization_service_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

-- Strip defaults/inherited direct ACLs; provisioning grants only the exact
-- current application role, never the drain-detection role list.
REVOKE ALL ON organization_service_accounts FROM PUBLIC;
DO $acl$
DECLARE grant_row record;
BEGIN
  FOR grant_row IN
    SELECT DISTINCT acl.grantee, pg_catalog.pg_get_userbyid(acl.grantee) AS role_name
    FROM pg_catalog.pg_class relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))) acl
    WHERE relation.oid = 'organization_service_accounts'::regclass
      AND acl.grantee <> 0 AND acl.grantee <> relation.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE organization_service_accounts FROM %I', grant_row.role_name);
  END LOOP;
END $acl$;