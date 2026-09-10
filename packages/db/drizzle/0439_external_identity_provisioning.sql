-- deployment-mode: maintenance
-- External identity storage/provisioning only. Does not grant workspace access,
-- activate private sessions, link native users, or change authentication.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0439 requires application database roles' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}')
      OR octet_length(item #>> '{}') > 63
  ) THEN RAISE EXCEPTION '0439 invalid application roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0439 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$drain$;

CREATE TABLE external_identities (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 200),
  external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 1024),
  subject_id text NOT NULL CHECK (subject_id = 'external_user:' || id::text),
  organization_membership_id uuid NOT NULL,
  personal_workspace_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','revoked')),
  authorization_revision bigint NOT NULL DEFAULT 1 CHECK (authorization_revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (account_id, source, external_id),
  UNIQUE (account_id, subject_id),
  FOREIGN KEY (organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id),
  FOREIGN KEY (personal_workspace_id, account_id) REFERENCES workspaces(id, account_id)
);
ALTER TABLE external_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY external_identity_lifecycle ON external_identities
  USING (account_id = opengeni_private.current_account_id()
    AND current_setting('opengeni.organization_tenancy_lifecycle', true) = 'external_identity_provisioning')
  WITH CHECK (account_id = opengeni_private.current_account_id()
    AND current_setting('opengeni.organization_tenancy_lifecycle', true) = 'external_identity_provisioning');
CREATE POLICY external_identity_provisioning ON organization_memberships
  USING (account_id = opengeni_private.current_account_id()
    AND current_setting('opengeni.organization_tenancy_lifecycle', true) = 'external_identity_provisioning')
  WITH CHECK (account_id = opengeni_private.current_account_id()
    AND current_setting('opengeni.organization_tenancy_lifecycle', true) = 'external_identity_provisioning');
REVOKE ALL ON external_identities FROM PUBLIC;

-- Account scope is established by the authenticated API before this call.
-- Like other lifecycle functions, this is not itself an HTTP authenticator.
CREATE FUNCTION ensure_external_identity(p_account_id uuid, p_source text, p_external_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$
DECLARE
  identity_row external_identities%ROWTYPE;
  membership_row organization_memberships%ROWTYPE;
  identity_id uuid;
  personal_id uuid;
  membership_id uuid;
  subject text;
  previous_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  previous_workspace text := current_setting('opengeni.workspace_id', true);
BEGIN
  IF p_account_id IS NULL OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_source IS NULL OR char_length(p_source) NOT BETWEEN 1 AND 200
    OR p_external_id IS NULL OR char_length(p_external_id) NOT BETWEEN 1 AND 1024
  THEN RAISE EXCEPTION 'invalid external identity scope' USING ERRCODE = '42501'; END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'external_identity_provisioning', true);
  -- Serialize a tuple without relying on delimiters in opaque host identifiers.
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_account_id,p_source,p_external_id)::text, 0));
  SELECT * INTO identity_row FROM external_identities
    WHERE account_id = p_account_id AND source = p_source AND external_id = p_external_id FOR UPDATE;
  IF NOT FOUND THEN
    identity_id := gen_random_uuid();
    subject := 'external_user:' || identity_id::text;
    PERFORM set_config('opengeni.workspace_id', '', true);
    INSERT INTO workspaces (account_id, name, external_source, external_id)
      VALUES (p_account_id, 'Personal workspace', 'opengeni:organization-membership', p_account_id::text || ':' || subject)
      RETURNING id INTO personal_id;
    PERFORM set_config('opengeni.workspace_id', personal_id::text, true);
    INSERT INTO workspace_inference_controls (workspace_id, account_id) VALUES (personal_id, p_account_id);
    INSERT INTO organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
      VALUES (p_account_id, subject, 'member', 'active', personal_id) RETURNING id INTO membership_id;
    INSERT INTO external_identities (id, account_id, source, external_id, subject_id, organization_membership_id, personal_workspace_id)
      VALUES (identity_id, p_account_id, p_source, p_external_id, subject, membership_id, personal_id)
      RETURNING * INTO identity_row;
  END IF;
  SELECT * INTO membership_row FROM organization_memberships
    WHERE id = identity_row.organization_membership_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND OR identity_row.status <> 'active' OR membership_row.status <> 'active'
    OR membership_row.subject_id IS DISTINCT FROM identity_row.subject_id
    OR membership_row.personal_workspace_id IS DISTINCT FROM identity_row.personal_workspace_id
  THEN RAISE EXCEPTION 'external identity is unavailable' USING ERRCODE = '42501'; END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
  PERFORM set_config('opengeni.workspace_id', coalesce(previous_workspace,''), true);
  RETURN jsonb_build_object('id', identity_row.id, 'accountId', identity_row.account_id,
    'source', identity_row.source, 'externalId', identity_row.external_id,
    'subjectId', identity_row.subject_id, 'organizationMembershipId', identity_row.organization_membership_id,
    'personalWorkspaceId', identity_row.personal_workspace_id, 'status', identity_row.status,
    'authorizationRevision', identity_row.authorization_revision);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker,''), true);
  PERFORM set_config('opengeni.workspace_id', coalesce(previous_workspace,''), true);
  RAISE;
END
$body$;
REVOKE ALL ON FUNCTION ensure_external_identity(uuid,text,text) FROM PUBLIC;
DO $acl$
DECLARE target_role record;
BEGIN
  FOR target_role IN SELECT DISTINCT role.rolname FROM pg_class relation
    CROSS JOIN LATERAL aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) privilege
    JOIN pg_roles role ON role.oid = privilege.grantee
    WHERE relation.oid = 'external_identities'::regclass AND privilege.grantee <> relation.relowner
  LOOP EXECUTE format('REVOKE ALL ON external_identities FROM %I', target_role.rolname); END LOOP;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a
    JOIN jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0439 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$acl$;