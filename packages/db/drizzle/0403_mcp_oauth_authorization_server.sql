-- deployment-mode: maintenance
-- Opt-in OAuth 2.1-style authorization-server state for exact workspace MCP
-- resources. Only hashes of authorization codes and bearer/refresh tokens are
-- retained; grants freeze permissions and tool identities for later live
-- intersection.
-- This changes the exact runtime-posture table/grant contract. Stop every API,
-- control worker, and turn worker before applying it, and never restart a
-- pre-0403 image after commit.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $mcp_oauth_runtime_drain_before$
DECLARE
  configured_roles_text text := nullif(
    current_setting('opengeni.migration_application_roles', true), ''
  );
  configured_roles jsonb;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION
      '0403 MCP OAuth activation requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0403 MCP OAuth activation received a malformed application database role list'
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
      '0403 MCP OAuth activation received an invalid application database role list'
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
      '0403 MCP OAuth activation requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$mcp_oauth_runtime_drain_before$;

CREATE TABLE mcp_oauth_clients (
  client_id text PRIMARY KEY CHECK (octet_length(client_id) BETWEEN 16 AND 256),
  redirect_uris jsonb NOT NULL CHECK (
    jsonb_typeof(redirect_uris) = 'array' AND jsonb_array_length(redirect_uris) BETWEEN 1 AND 16
  ),
  client_name text CHECK (client_name IS NULL OR octet_length(client_name) BETWEEN 1 AND 200),
  token_endpoint_auth_method text NOT NULL DEFAULT 'none' CHECK (token_endpoint_auth_method = 'none'),
  grant_types jsonb NOT NULL CHECK (jsonb_typeof(grant_types) = 'array'),
  response_types jsonb NOT NULL CHECK (response_types = '["code"]'::jsonb),
  registration_scope_hash text NOT NULL CHECK (registration_scope_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '1 day'),
  CHECK (expires_at > created_at)
);
CREATE INDEX mcp_oauth_clients_created_idx ON mcp_oauth_clients(created_at);
CREATE INDEX mcp_oauth_clients_scope_created_idx
  ON mcp_oauth_clients(registration_scope_hash, created_at);
CREATE INDEX mcp_oauth_clients_expires_idx ON mcp_oauth_clients(expires_at, client_id);

CREATE TABLE mcp_oauth_authorization_requests (
  request_hash text PRIMARY KEY CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  client_id text NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_id text NOT NULL CHECK (octet_length(subject_id) BETWEEN 1 AND 1024),
  resource text NOT NULL CHECK (octet_length(resource) BETWEEN 1 AND 2048),
  redirect_uri text NOT NULL CHECK (octet_length(redirect_uri) BETWEEN 1 AND 2048),
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  state text CHECK (state IS NULL OR octet_length(state) BETWEEN 1 AND 1024),
  permissions jsonb NOT NULL CHECK (jsonb_typeof(permissions) = 'array'),
  tool_identities jsonb NOT NULL CHECK (
    jsonb_typeof(tool_identities) = 'array' AND jsonb_array_length(tool_identities) <= 4096
  ),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mcp_oauth_authorization_requests
  ADD CONSTRAINT mcp_oauth_authorization_requests_workspace_account_fk
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;
CREATE INDEX mcp_oauth_authorization_requests_expires_idx
  ON mcp_oauth_authorization_requests(expires_at);

CREATE TABLE mcp_oauth_authorization_codes (
  code_hash text PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  client_id text NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_id text NOT NULL CHECK (octet_length(subject_id) BETWEEN 1 AND 1024),
  resource text NOT NULL CHECK (octet_length(resource) BETWEEN 1 AND 2048),
  redirect_uri text NOT NULL CHECK (octet_length(redirect_uri) BETWEEN 1 AND 2048),
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  permissions jsonb NOT NULL CHECK (jsonb_typeof(permissions) = 'array'),
  tool_identities jsonb NOT NULL CHECK (
    jsonb_typeof(tool_identities) = 'array' AND jsonb_array_length(tool_identities) <= 4096
  ),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mcp_oauth_authorization_codes
  ADD CONSTRAINT mcp_oauth_authorization_codes_workspace_account_fk
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;
CREATE INDEX mcp_oauth_authorization_codes_expires_idx
  ON mcp_oauth_authorization_codes(expires_at);

CREATE TABLE mcp_oauth_refresh_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  family_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  client_id text NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_id text NOT NULL CHECK (octet_length(subject_id) BETWEEN 1 AND 1024),
  resource text NOT NULL CHECK (octet_length(resource) BETWEEN 1 AND 2048),
  permissions jsonb NOT NULL CHECK (jsonb_typeof(permissions) = 'array'),
  tool_identities jsonb NOT NULL CHECK (
    jsonb_typeof(tool_identities) = 'array' AND jsonb_array_length(tool_identities) <= 4096
  ),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, generation)
);
ALTER TABLE mcp_oauth_refresh_tokens
  ADD CONSTRAINT mcp_oauth_refresh_tokens_workspace_account_fk
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;
CREATE INDEX mcp_oauth_refresh_tokens_expires_idx ON mcp_oauth_refresh_tokens(expires_at);

CREATE TABLE mcp_oauth_access_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  refresh_family_id uuid NOT NULL,
  refresh_generation integer NOT NULL CHECK (refresh_generation > 0),
  client_id text NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_id text NOT NULL CHECK (octet_length(subject_id) BETWEEN 1 AND 1024),
  resource text NOT NULL CHECK (octet_length(resource) BETWEEN 1 AND 2048),
  permissions jsonb NOT NULL CHECK (jsonb_typeof(permissions) = 'array'),
  tool_identities jsonb NOT NULL CHECK (
    jsonb_typeof(tool_identities) = 'array' AND jsonb_array_length(tool_identities) <= 4096
  ),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mcp_oauth_access_tokens
  ADD CONSTRAINT mcp_oauth_access_tokens_workspace_account_fk
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;
CREATE INDEX mcp_oauth_access_tokens_family_idx
  ON mcp_oauth_access_tokens(refresh_family_id, refresh_generation);
CREATE INDEX mcp_oauth_access_tokens_expires_idx ON mcp_oauth_access_tokens(expires_at);

-- Public dynamic client registration must remain bounded across every API
-- replica. Untouched registrations expire after one day; a successful client
-- lookup extends the client through the maximum refresh-token lifetime plus a
-- one-day grace period. The reaper is deliberately batch-bounded and is invoked
-- by registration and client lookup, so normal OAuth traffic continuously
-- removes expired protocol state without a separate scheduler.
CREATE FUNCTION opengeni_private.reap_mcp_oauth_state(p_limit integer DEFAULT 128)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  bounded_limit integer := least(greatest(coalesce(p_limit, 128), 1), 1000);
  removed integer := 0;
  affected integer;
BEGIN
  WITH expired AS (
    SELECT request_hash
    FROM mcp_oauth_authorization_requests
    WHERE expires_at <= pg_catalog.clock_timestamp()
    ORDER BY expires_at, request_hash
    FOR UPDATE SKIP LOCKED
    LIMIT bounded_limit
  )
  DELETE FROM mcp_oauth_authorization_requests target
  USING expired
  WHERE target.request_hash = expired.request_hash;
  GET DIAGNOSTICS affected = ROW_COUNT;
  removed := removed + affected;

  WITH expired AS (
    SELECT code_hash
    FROM mcp_oauth_authorization_codes
    WHERE expires_at <= pg_catalog.clock_timestamp()
    ORDER BY expires_at, code_hash
    FOR UPDATE SKIP LOCKED
    LIMIT bounded_limit
  )
  DELETE FROM mcp_oauth_authorization_codes target
  USING expired
  WHERE target.code_hash = expired.code_hash;
  GET DIAGNOSTICS affected = ROW_COUNT;
  removed := removed + affected;

  WITH expired AS (
    SELECT token_hash
    FROM mcp_oauth_access_tokens
    WHERE expires_at <= pg_catalog.clock_timestamp()
      OR revoked_at <= pg_catalog.clock_timestamp() - interval '1 day'
    ORDER BY expires_at, token_hash
    FOR UPDATE SKIP LOCKED
    LIMIT bounded_limit
  )
  DELETE FROM mcp_oauth_access_tokens target
  USING expired
  WHERE target.token_hash = expired.token_hash;
  GET DIAGNOSTICS affected = ROW_COUNT;
  removed := removed + affected;

  WITH expired AS (
    SELECT candidate.token_hash
    FROM mcp_oauth_refresh_tokens candidate
    WHERE (
      candidate.expires_at <= pg_catalog.clock_timestamp()
      OR candidate.revoked_at <= pg_catalog.clock_timestamp() - interval '1 day'
    )
      -- A rotated generation is the durable replay detector for its family.
      -- Keep every tombstone until no descendant refresh token can remain live.
      AND NOT EXISTS (
        SELECT 1
        FROM mcp_oauth_refresh_tokens live_family
        WHERE live_family.family_id = candidate.family_id
          AND live_family.revoked_at IS NULL
          AND live_family.expires_at > pg_catalog.clock_timestamp()
      )
    ORDER BY candidate.expires_at, candidate.token_hash
    FOR UPDATE SKIP LOCKED
    LIMIT bounded_limit
  )
  DELETE FROM mcp_oauth_refresh_tokens target
  USING expired
  WHERE target.token_hash = expired.token_hash;
  GET DIAGNOSTICS affected = ROW_COUNT;
  removed := removed + affected;

  WITH expired AS (
    SELECT client_id
    FROM mcp_oauth_clients
    WHERE expires_at <= pg_catalog.clock_timestamp()
    ORDER BY expires_at, client_id
    FOR UPDATE SKIP LOCKED
    LIMIT bounded_limit
  )
  DELETE FROM mcp_oauth_clients target
  USING expired
  WHERE target.client_id = expired.client_id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN removed + affected;
END
$body$;

CREATE FUNCTION opengeni_private.register_mcp_oauth_client(
  p_client_id text,
  p_redirect_uris jsonb,
  p_client_name text,
  p_grant_types jsonb,
  p_response_types jsonb,
  p_registration_scope_hash text
)
RETURNS SETOF mcp_oauth_clients
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  now_value timestamptz := pg_catalog.clock_timestamp();
  global_count bigint;
  scoped_count bigint;
BEGIN
  IF p_registration_scope_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid MCP OAuth registration scope'
      USING ERRCODE = '22023';
  END IF;

  -- One short global transaction lock makes the count-and-insert quota exact
  -- across replicas. Registration is rare and the lock is held only for this
  -- bounded cleanup/count/insert command.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('opengeni:mcp-oauth:registration', 0)
  );
  PERFORM opengeni_private.reap_mcp_oauth_state(128);

  SELECT count(*) INTO global_count
  FROM mcp_oauth_clients
  WHERE created_at > now_value - interval '10 minutes';

  SELECT count(*) INTO scoped_count
  FROM mcp_oauth_clients
  WHERE registration_scope_hash = p_registration_scope_hash
    AND created_at > now_value - interval '10 minutes';

  IF global_count >= 600 OR scoped_count >= 20 THEN
    RAISE EXCEPTION 'MCP OAuth client registration rate limited'
      USING ERRCODE = 'P0004';
  END IF;

  RETURN QUERY
  INSERT INTO mcp_oauth_clients (
    client_id, redirect_uris, client_name, grant_types, response_types,
    registration_scope_hash, expires_at
  ) VALUES (
    p_client_id, p_redirect_uris, p_client_name, p_grant_types, p_response_types,
    p_registration_scope_hash, now_value + interval '1 day'
  )
  RETURNING *;
END
$body$;

REVOKE ALL ON mcp_oauth_clients, mcp_oauth_authorization_requests,
  mcp_oauth_authorization_codes, mcp_oauth_refresh_tokens, mcp_oauth_access_tokens FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.reap_mcp_oauth_state(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.register_mcp_oauth_client(
  text, jsonb, text, jsonb, jsonb, text
) FROM PUBLIC;

-- Owner ALTER DEFAULT PRIVILEGES may still name a legacy application login or
-- an old side of a role rotation. The exact role list above is drain detection
-- only. Strip every explicit non-owner ACL from the new objects; the mandatory
-- post-migration db:provision-roles step grants only the deployment's current
-- target application role.
DO $mcp_oauth_table_acl_reset$
DECLARE
  data_schema text := pg_catalog.current_schema();
  relation_name text;
  role_name text;
BEGIN
  FOR relation_name IN
    SELECT relation.value
    FROM pg_catalog.unnest(
      ARRAY[
        'mcp_oauth_clients',
        'mcp_oauth_authorization_requests',
        'mcp_oauth_authorization_codes',
        'mcp_oauth_refresh_tokens',
        'mcp_oauth_access_tokens'
      ]::text[]
    ) AS relation(value)
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON TABLE %I.%I FROM PUBLIC',
      data_schema,
      relation_name
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
          pg_catalog.format('%I.%I', data_schema, relation_name)
        )
        AND privilege.grantee <> 0
        AND privilege.grantee <> relation.relowner
      GROUP BY grantee_role.rolname
      ORDER BY grantee_role.rolname COLLATE "C"
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON TABLE %I.%I FROM %I',
        data_schema,
        relation_name,
        role_name
      );
    END LOOP;
  END LOOP;
END
$mcp_oauth_table_acl_reset$;

DO $mcp_oauth_function_acl_reset$
DECLARE
  role_name text;
  target record;
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      (
        'reap_mcp_oauth_state'::text,
        'p_limit integer'::text,
        'integer'::text
      ),
      (
        'register_mcp_oauth_client'::text,
        'p_client_id text, p_redirect_uris jsonb, p_client_name text, p_grant_types jsonb, p_response_types jsonb, p_registration_scope_hash text'::text,
        'text, jsonb, text, jsonb, jsonb, text'::text
      )
    ) target_row(function_name, identity_arguments, call_arguments)
  LOOP
    FOR role_name IN
      SELECT grantee_role.rolname
      FROM pg_catalog.pg_proc procedure
      INNER JOIN pg_catalog.pg_namespace namespace
        ON namespace.oid = procedure.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        coalesce(
          procedure.proacl,
          pg_catalog.acldefault('f', procedure.proowner)
        )
      ) privilege
      INNER JOIN pg_catalog.pg_roles grantee_role
        ON grantee_role.oid = privilege.grantee
      WHERE namespace.nspname = 'opengeni_private'
        AND procedure.proname = target.function_name
        AND pg_catalog.pg_get_function_identity_arguments(procedure.oid) =
          target.identity_arguments
        AND privilege.grantee <> 0
        AND privilege.grantee <> procedure.proowner
      GROUP BY grantee_role.rolname
      ORDER BY grantee_role.rolname COLLATE "C"
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION opengeni_private.%I(%s) FROM %I',
        target.function_name,
        target.call_arguments,
        role_name
      );
    END LOOP;
  END LOOP;
END
$mcp_oauth_function_acl_reset$;

DO $mcp_oauth_runtime_drain_after$
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
      '0403 MCP OAuth activation observed a configured OpenGeni application database session after schema installation'
      USING ERRCODE = '55000';
  END IF;
END
$mcp_oauth_runtime_drain_after$;
