-- deployment-mode: maintenance
-- Native namespace routing changes the exact runtime role contract. Stop old
-- API/worker processes, migrate/provision roles, then start matching binaries.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' OR jsonb_array_length(roles) NOT BETWEEN 1 AND 16 THEN
    RAISE EXCEPTION '0463 requires application database roles' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
    OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}') OR octet_length(item #>> '{}') > 63)
  OR EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0463 requires valid stopped application roles' USING ERRCODE = '55000';
  END IF;
END
$drain$;

CREATE TABLE host_mcp_resolvers (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  external_source text NOT NULL CHECK (length(external_source) BETWEEN 1 AND 200 AND external_source = btrim(external_source)),
  url text NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
  secret_encrypted text NOT NULL,
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 100 AND 30000),
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (account_id, external_source)
);
CREATE TABLE host_mcp_resolver_operations (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  actor_subject_id text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, operation_id)
);
ALTER TABLE host_mcp_resolvers ENABLE ROW LEVEL SECURITY;
ALTER TABLE host_mcp_resolvers FORCE ROW LEVEL SECURITY;
ALTER TABLE host_mcp_resolver_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE host_mcp_resolver_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY host_mcp_resolvers_account ON host_mcp_resolvers
  USING (account_id = opengeni_private.current_account_id())
  WITH CHECK (account_id = opengeni_private.current_account_id());
CREATE POLICY host_mcp_resolver_operations_account ON host_mcp_resolver_operations
  USING (account_id = opengeni_private.current_account_id())
  WITH CHECK (account_id = opengeni_private.current_account_id());

CREATE FUNCTION opengeni_private.guard_host_mcp_resolver_write() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $body$
DECLARE permissions_value jsonb;
BEGIN
  SELECT credential.permissions INTO permissions_value FROM api_keys credential
  WHERE credential.account_id = NEW.account_id
    AND 'api_key:' || credential.id::text = opengeni_private.current_subject_id()
    AND credential.workspace_id IS NULL AND credential.credential_kind = 'organization'
    AND credential.revoked_at IS NULL
    AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
  FOR SHARE;
  IF NEW.account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR NOT coalesce(permissions_value ? 'account:admin', false) THEN
    RAISE EXCEPTION 'organization service administration required' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME = 'host_mcp_resolvers' THEN
    IF TG_OP = 'UPDATE' THEN
      IF ROW(NEW.id, NEW.account_id, NEW.external_source, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id, OLD.account_id, OLD.external_source, OLD.created_at)
        OR NEW.generation <> OLD.generation + 1 THEN
        RAISE EXCEPTION 'resolver identity or generation conflict' USING ERRCODE = '40001';
      END IF;
    ELSIF NEW.generation <> 1 THEN
      RAISE EXCEPTION 'initial resolver generation invalid' USING ERRCODE = '22023';
    END IF;
  ELSIF NEW.actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id() THEN
    RAISE EXCEPTION 'resolver operation actor invalid' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER host_mcp_resolver_write BEFORE INSERT OR UPDATE ON host_mcp_resolvers
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_host_mcp_resolver_write();
CREATE TRIGGER host_mcp_resolver_operation_write BEFORE INSERT ON host_mcp_resolver_operations
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_host_mcp_resolver_write();
REVOKE ALL ON FUNCTION opengeni_private.guard_host_mcp_resolver_write() FROM PUBLIC;
REVOKE ALL ON TABLE host_mcp_resolvers, host_mcp_resolver_operations FROM PUBLIC;
DO $acl$
DECLARE target_role record;
BEGIN
  FOR target_role IN SELECT DISTINCT role.rolname FROM pg_class relation
    CROSS JOIN LATERAL aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) privilege
    JOIN pg_roles role ON role.oid = privilege.grantee
    WHERE relation.oid IN ('host_mcp_resolvers'::regclass, 'host_mcp_resolver_operations'::regclass)
      AND privilege.grantee <> relation.relowner
  LOOP EXECUTE format('REVOKE ALL ON TABLE host_mcp_resolvers, host_mcp_resolver_operations FROM %I', target_role.rolname); END LOOP;
  FOR target_role IN SELECT DISTINCT role.rolname FROM pg_proc routine
    CROSS JOIN LATERAL aclexplode(coalesce(routine.proacl, acldefault('f', routine.proowner))) privilege
    JOIN pg_roles role ON role.oid = privilege.grantee
    WHERE routine.oid = 'opengeni_private.guard_host_mcp_resolver_write()'::regprocedure AND privilege.grantee <> routine.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.guard_host_mcp_resolver_write() FROM %I', target_role.rolname); END LOOP;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a
    JOIN jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0463 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$acl$;