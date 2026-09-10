-- deployment-mode: maintenance
-- The exact runtime table/RLS/grant contract changes. Drain all old API and
-- worker logins and provision only the matching binary's role after migration.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $drain$
DECLARE
  roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0438 requires an explicit application database role list' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item
    WHERE jsonb_typeof(item) <> 'string' OR btrim(item #>> '{}') = ''
      OR item #>> '{}' <> btrim(item #>> '{}') OR octet_length(item #>> '{}') > 63
  ) THEN
    RAISE EXCEPTION '0438 received invalid application database roles' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(roles) role_name ON role_name = activity.usename
    WHERE activity.datname = current_database() AND activity.pid <> pg_backend_pid()
  ) THEN
    RAISE EXCEPTION '0438 requires all application database sessions stopped' USING ERRCODE = '55000';
  END IF;
END
$drain$;

CREATE TABLE connect_attempts (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  subject_id text NOT NULL CHECK (octet_length(subject_id) BETWEEN 1 AND 1024),
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  return_url text NOT NULL CHECK (octet_length(return_url) BETWEEN 1 AND 4096),
  projection jsonb NOT NULL CHECK (jsonb_typeof(projection) = 'object' AND octet_length(projection::text) <= 1048576),
  operation_id text CHECK (octet_length(operation_id) BETWEEN 1 AND 512),
  operation_digest text CHECK (operation_digest ~ '^[0-9a-f]{64}$'),
  receipts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(receipts) = 'object' AND octet_length(receipts::text) <= 4194304),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connect_attempts_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT connect_attempts_operation_pair_check CHECK ((operation_id IS NULL) = (operation_digest IS NULL)),
  CONSTRAINT connect_attempts_projection_identity_check CHECK (
    projection ?& ARRAY['id', 'workspaceId', 'revision', 'state', 'expiresAt']
    AND projection->>'id' = id::text AND projection->>'workspaceId' = workspace_id::text
    AND (projection->>'revision')::bigint > 0
    AND (projection->>'expiresAt')::timestamptz = expires_at
  )
);
CREATE UNIQUE INDEX connect_attempts_actor_idempotency_idx ON connect_attempts
  (workspace_id, subject_id, idempotency_key_hash);
CREATE INDEX connect_attempts_actor_pending_idx ON connect_attempts
  (workspace_id, subject_id, created_at DESC, id DESC)
  WHERE projection->>'state' NOT IN ('complete','cancelled','expired');
CREATE INDEX connect_attempts_expiry_idx ON connect_attempts (expires_at, id);

ALTER TABLE connect_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE connect_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY connect_attempts_actor_scope ON connect_attempts
  USING (account_id = opengeni_private.current_account_id()
    AND workspace_id = opengeni_private.current_workspace_id()
    AND subject_id = opengeni_private.current_subject_id())
  WITH CHECK (account_id = opengeni_private.current_account_id()
    AND workspace_id = opengeni_private.current_workspace_id()
    AND subject_id = opengeni_private.current_subject_id());

-- New-table defaults must not leave privileges for old or unrelated logins.
REVOKE ALL ON TABLE connect_attempts FROM PUBLIC;
DO $acl$
DECLARE target_role record;
BEGIN
  FOR target_role IN
    SELECT DISTINCT role.rolname FROM pg_class relation
    CROSS JOIN LATERAL aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) privilege
    JOIN pg_roles role ON role.oid = privilege.grantee
    WHERE relation.oid = 'connect_attempts'::regclass AND privilege.grantee <> relation.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE connect_attempts FROM %I', target_role.rolname);
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) role_name
      ON role_name = activity.usename
    WHERE activity.datname = current_database() AND activity.pid <> pg_backend_pid()
  ) THEN
    RAISE EXCEPTION '0438 requires all application database sessions stopped' USING ERRCODE = '55000';
  END IF;
END
$acl$;