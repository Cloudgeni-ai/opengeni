-- deployment-mode: maintenance
-- Optional, credential-free host authority. Existing inline and host refs do
-- not opt in automatically. Drain old runtimes before changing the role contract.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0443 requires application database roles' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}')
      OR octet_length(item #>> '{}') > 63
  ) THEN RAISE EXCEPTION '0443 invalid application roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0443 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$drain$;

CREATE TABLE host_mcp_bindings (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  owner_subject_id text NOT NULL,
  authorization_revision bigint NOT NULL CHECK (authorization_revision BETWEEN 1 AND 9007199254740991),
  operation_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object' AND octet_length(definition::text) <= 131072),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 9007199254740991),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  CONSTRAINT host_mcp_bindings_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT host_mcp_bindings_external_owner_fk FOREIGN KEY (account_id, owner_subject_id)
    REFERENCES external_identities(account_id, subject_id),
  CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL)),
  UNIQUE (workspace_id, owner_subject_id, operation_id)
);
CREATE INDEX host_mcp_bindings_owner_idx ON host_mcp_bindings(workspace_id, owner_subject_id, created_at, id);
ALTER TABLE host_mcp_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE host_mcp_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY host_mcp_bindings_owner_scope ON host_mcp_bindings
  USING (account_id = opengeni_private.current_account_id()
    AND workspace_id = opengeni_private.current_workspace_id()
    AND owner_subject_id = opengeni_private.current_subject_id())
  WITH CHECK (account_id = opengeni_private.current_account_id()
    AND workspace_id = opengeni_private.current_workspace_id()
    AND owner_subject_id = opengeni_private.current_subject_id());

CREATE FUNCTION opengeni_private.guard_host_mcp_binding_update() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $body$
BEGIN
  IF ROW(NEW.id, NEW.account_id, NEW.workspace_id, NEW.owner_subject_id,
      NEW.authorization_revision, NEW.operation_id, NEW.request_digest, NEW.definition, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.account_id, OLD.workspace_id, OLD.owner_subject_id,
      OLD.authorization_revision, OLD.operation_id, OLD.request_digest, OLD.definition, OLD.created_at)
    OR OLD.status <> 'active' OR NEW.status <> 'revoked'
    OR NEW.generation <> OLD.generation + 1 OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'host binding identity is immutable and revocation is terminal' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER host_mcp_binding_immutable BEFORE UPDATE ON host_mcp_bindings
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_host_mcp_binding_update();
REVOKE ALL ON FUNCTION opengeni_private.guard_host_mcp_binding_update() FROM PUBLIC;
REVOKE ALL ON TABLE host_mcp_bindings FROM PUBLIC;
DO $acl$
DECLARE target_role record;
BEGIN
  FOR target_role IN SELECT DISTINCT role.rolname FROM pg_class relation
    CROSS JOIN LATERAL aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) privilege
    JOIN pg_roles role ON role.oid = privilege.grantee
    WHERE relation.oid = 'host_mcp_bindings'::regclass AND privilege.grantee <> relation.relowner
  LOOP EXECUTE format('REVOKE ALL ON TABLE host_mcp_bindings FROM %I', target_role.rolname); END LOOP;
  FOR target_role IN SELECT DISTINCT role.rolname FROM pg_proc routine
    CROSS JOIN LATERAL aclexplode(coalesce(routine.proacl, acldefault('f', routine.proowner))) privilege
    JOIN pg_roles role ON role.oid = privilege.grantee
    WHERE routine.oid = 'opengeni_private.guard_host_mcp_binding_update()'::regprocedure
      AND privilege.grantee <> routine.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.guard_host_mcp_binding_update() FROM %I', target_role.rolname); END LOOP;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a
    JOIN jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0443 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$acl$;