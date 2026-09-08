-- deployment-mode: maintenance
-- Owner-scoped delegation metadata. This does not admit execution.
-- Accepted-work capture and runtime authorization are separate seams.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0420 requires application database roles' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}')
      OR octet_length(item #>> '{}') > 63
  ) THEN RAISE EXCEPTION '0420 invalid application roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0420 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$drain$;

CREATE TABLE host_mcp_delegations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  owner_subject_id text NOT NULL,
  owner_authorization_revision bigint NOT NULL CHECK (owner_authorization_revision BETWEEN 1 AND 9007199254740991),
  binding_id uuid NOT NULL REFERENCES host_mcp_bindings(id),
  binding_generation bigint NOT NULL CHECK (binding_generation BETWEEN 1 AND 9007199254740991),
  operation_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  grant_definition jsonb NOT NULL CHECK (jsonb_typeof(grant_definition) = 'object' AND octet_length(grant_definition::text) <= 4096),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 9007199254740991),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  CONSTRAINT host_mcp_delegations_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT host_mcp_delegations_external_owner_fk FOREIGN KEY (account_id, owner_subject_id)
    REFERENCES external_identities(account_id, subject_id),
  CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL)),
  UNIQUE (workspace_id, owner_subject_id, operation_id)
);
CREATE INDEX host_mcp_delegations_owner_idx ON host_mcp_delegations(workspace_id, owner_subject_id, binding_id, id);
ALTER TABLE host_mcp_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE host_mcp_delegations FORCE ROW LEVEL SECURITY;
CREATE POLICY host_mcp_delegations_owner_scope ON host_mcp_delegations
  USING (account_id = opengeni_private.current_account_id()
    AND workspace_id = opengeni_private.current_workspace_id()
    AND owner_subject_id = opengeni_private.current_subject_id())
  WITH CHECK (account_id = opengeni_private.current_account_id()
    AND workspace_id = opengeni_private.current_workspace_id()
    AND owner_subject_id = opengeni_private.current_subject_id());

CREATE FUNCTION opengeni_private.guard_host_mcp_delegation() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $body$
DECLARE binding host_mcp_bindings%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.account_id, NEW.workspace_id, NEW.owner_subject_id,
        NEW.owner_authorization_revision, NEW.binding_id, NEW.binding_generation,
        NEW.operation_id, NEW.request_digest, NEW.grant_definition, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.account_id, OLD.workspace_id, OLD.owner_subject_id,
        OLD.owner_authorization_revision, OLD.binding_id, OLD.binding_generation,
        OLD.operation_id, OLD.request_digest, OLD.grant_definition, OLD.created_at)
      OR OLD.status <> 'active' OR NEW.status <> 'revoked'
      OR NEW.generation <> OLD.generation + 1 OR NEW.revoked_at IS NULL THEN
      RAISE EXCEPTION 'host delegation identity is immutable and revocation is terminal' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  SELECT b.* INTO binding FROM host_mcp_bindings b WHERE b.id = NEW.binding_id FOR SHARE;
  IF NOT FOUND OR binding.status <> 'active' OR binding.revoked_at IS NOT NULL
    OR binding.account_id <> NEW.account_id OR binding.workspace_id <> NEW.workspace_id
    OR binding.owner_subject_id <> NEW.owner_subject_id
    OR binding.authorization_revision <> NEW.owner_authorization_revision
    OR binding.generation <> NEW.binding_generation
    OR NEW.status <> 'active' OR NEW.generation <> 1 OR NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'host delegation binding unavailable' USING ERRCODE = '42501';
  END IF;
  IF (NEW.grant_definition ->> 'scope') IS DISTINCT FROM 'user'
    OR coalesce(NEW.grant_definition ->> 'mode', '') NOT IN ('session','always')
    OR coalesce(NEW.grant_definition ->> 'context', '') NOT IN ('user_private','workspace_shared')
    OR jsonb_typeof(NEW.grant_definition -> 'workspaceSharedAcknowledged') IS DISTINCT FROM 'boolean'
    OR (NEW.grant_definition ->> 'context' = 'workspace_shared'
      AND NEW.grant_definition -> 'workspaceSharedAcknowledged' <> 'true'::jsonb)
    OR NEW.grant_definition - ARRAY['scope','mode','context','sessionId','expectedAuthorityEpoch','workspaceSharedAcknowledged'] <> '{}'::jsonb
    OR ((NEW.grant_definition ->> 'sessionId') IS NULL) IS DISTINCT FROM
       ((NEW.grant_definition ->> 'expectedAuthorityEpoch') IS NULL)
    OR (NEW.grant_definition ->> 'mode' = 'session' AND NEW.grant_definition ->> 'sessionId' IS NULL)
    OR (NEW.grant_definition ->> 'mode' = 'always' AND NEW.grant_definition ->> 'sessionId' IS NOT NULL)
  THEN RAISE EXCEPTION 'invalid host delegation scope' USING ERRCODE = '22023'; END IF;
  IF NEW.grant_definition ->> 'sessionId' IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sessions s WHERE s.id = (NEW.grant_definition ->> 'sessionId')::uuid
      AND s.account_id = NEW.account_id AND s.workspace_id = NEW.workspace_id
      AND s.visibility = NEW.grant_definition ->> 'context'
      AND s.authority_epoch = (NEW.grant_definition ->> 'expectedAuthorityEpoch')::bigint
      AND (s.visibility = 'workspace_shared' OR s.owner_subject_id = NEW.owner_subject_id)
  ) THEN RAISE EXCEPTION 'host delegation session unavailable' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER host_mcp_delegation_guard BEFORE INSERT OR UPDATE ON host_mcp_delegations
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_host_mcp_delegation();
REVOKE ALL ON FUNCTION opengeni_private.guard_host_mcp_delegation() FROM PUBLIC;
REVOKE ALL ON TABLE host_mcp_delegations FROM PUBLIC;
DO $acl$
DECLARE target_role record;
BEGIN
  FOR target_role IN SELECT DISTINCT role.rolname FROM pg_class relation
    CROSS JOIN LATERAL aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) privilege
    JOIN pg_roles role ON role.oid = privilege.grantee
    WHERE relation.oid = 'host_mcp_delegations'::regclass AND privilege.grantee <> relation.relowner
  LOOP EXECUTE format('REVOKE ALL ON TABLE host_mcp_delegations FROM %I', target_role.rolname); END LOOP;
  FOR target_role IN SELECT DISTINCT role.rolname FROM pg_proc routine
    CROSS JOIN LATERAL aclexplode(coalesce(routine.proacl, acldefault('f', routine.proowner))) privilege
    JOIN pg_roles role ON role.oid = privilege.grantee
    WHERE routine.oid = 'opengeni_private.guard_host_mcp_delegation()'::regprocedure
      AND privilege.grantee <> routine.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.guard_host_mcp_delegation() FROM %I', target_role.rolname); END LOOP;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a
    JOIN jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0420 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$acl$;