-- deployment-mode: rolling
-- Nango-backed integrations (docs/nango.md).
--
--   1. integration_backend_revisions: the deployment-wide, append-only
--      operator setting that decides, per catalog integration key, whether
--      the native connector or Nango serves it. It is also the allowlist:
--      nothing from Nango is offered unless the newest revision for a key
--      says backend = 'nango' and enabled. Operators change it only through
--      the owner-only audited setter set_integration_backend(...); runtime
--      roles may only read it.
--   2. nango_usage_events: append-only record of Nango connection lifecycle
--      events, proxy requests and tool calls, for per organization,
--      workspace, integration and user usage and cost estimates. Organization
--      scope reads its own rows; the runtime may only read and insert.
--   3. nango_affected_connections(key): owner-only operator export of the
--      native and Nango connections of one integration across organizations,
--      used before and at a backend swap.
--
-- Rolling: two new FORCE-RLS tables, one invoker view of the effective
-- switch, two owner-only SECURITY INVOKER functions and one owner-only read
-- policy on social_connections, none of which the previous release reads,
-- writes or calls. No existing object is altered or dropped.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE integration_backend_revisions (
  revision bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  integration_key text NOT NULL,
  backend text NOT NULL,
  nango_provider_config_key text,
  enabled boolean NOT NULL,
  definition jsonb,
  changed_by text NOT NULL,
  reason text NOT NULL,
  database_role text NOT NULL DEFAULT session_user,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT integration_backend_revisions_key_check
    CHECK (integration_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  CONSTRAINT integration_backend_revisions_backend_check
    CHECK (backend IN ('native', 'nango')),
  CONSTRAINT integration_backend_revisions_provider_config_key_check
    CHECK (nango_provider_config_key IS NULL
      OR nango_provider_config_key ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'),
  CONSTRAINT integration_backend_revisions_nango_key_check
    CHECK (backend <> 'nango' OR nango_provider_config_key IS NOT NULL),
  CONSTRAINT integration_backend_revisions_definition_check
    CHECK (definition IS NULL
      OR (jsonb_typeof(definition) = 'object' AND octet_length(definition::text) <= 32768)),
  CONSTRAINT integration_backend_revisions_changed_by_check
    CHECK (changed_by = btrim(changed_by) AND char_length(changed_by) BETWEEN 1 AND 200),
  CONSTRAINT integration_backend_revisions_reason_check
    CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 6 AND 1000)
);
CREATE INDEX integration_backend_revisions_key_idx
  ON integration_backend_revisions (integration_key, revision DESC);
COMMENT ON TABLE integration_backend_revisions IS 'Append-only operator switch: which backend (native or nango) serves each catalog integration. The newest revision per key is effective.';

-- The switch in effect right now, one row per integration key (read-only).
CREATE VIEW integration_backends_effective WITH (security_invoker = true) AS
  SELECT DISTINCT ON (integration_key)
    integration_key, backend, nango_provider_config_key, enabled, definition,
    revision, changed_by, reason, changed_at
  FROM integration_backend_revisions
  ORDER BY integration_key, revision DESC;
COMMENT ON VIEW integration_backends_effective IS 'Newest integration_backend_revisions row per integration key. Nango serves a key only when backend = nango, enabled, and the deployment has a Nango secret key.';

CREATE TABLE nango_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  subject_id text,
  integration_key text NOT NULL,
  provider_config_key text NOT NULL,
  connection_id uuid,
  nango_connection_id text NOT NULL,
  kind text NOT NULL,
  tool_name text,
  http_method text,
  http_status integer,
  request_bytes bigint NOT NULL DEFAULT 0,
  response_bytes bigint NOT NULL DEFAULT 0,
  duration_ms integer,
  CONSTRAINT nango_usage_events_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT nango_usage_events_kind_check CHECK (kind IN (
    'connection_created', 'connection_reconnected', 'connection_deleted',
    'connection_needs_reauth', 'proxy_request', 'tool_call')),
  CONSTRAINT nango_usage_events_bounds_check CHECK (
    char_length(integration_key) BETWEEN 1 AND 64
    AND char_length(provider_config_key) BETWEEN 1 AND 128
    AND char_length(nango_connection_id) BETWEEN 1 AND 255
    AND (subject_id IS NULL OR char_length(subject_id) <= 512)
    AND (tool_name IS NULL OR char_length(tool_name) <= 200)
    AND (http_method IS NULL OR char_length(http_method) <= 16)
    AND request_bytes >= 0 AND response_bytes >= 0
    AND (duration_ms IS NULL OR duration_ms >= 0))
);
CREATE INDEX nango_usage_events_account_idx ON nango_usage_events (account_id, occurred_at);
CREATE INDEX nango_usage_events_connection_idx
  ON nango_usage_events (account_id, nango_connection_id, occurred_at)
  WHERE kind IN ('connection_created', 'connection_reconnected', 'connection_deleted');
CREATE INDEX nango_usage_events_occurred_idx ON nango_usage_events (occurred_at);
COMMENT ON TABLE nango_usage_events IS 'Append-only Nango usage: connection lifecycle, proxy requests and tool calls, for cost estimates and invoice reconciliation.';

ALTER TABLE integration_backend_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_backend_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE nango_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE nango_usage_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE integration_backend_revisions FROM PUBLIC;
REVOKE ALL ON TABLE integration_backends_effective FROM PUBLIC;
REVOKE ALL ON TABLE nango_usage_events FROM PUBLIC;

-- The setting is deployment-wide: every role that holds SELECT reads it.
CREATE POLICY deployment_read ON integration_backend_revisions FOR SELECT USING (true);
-- Organization scope reads its own usage; a workspace scope its workspace.
CREATE POLICY account_isolation ON nango_usage_events
  USING (opengeni_private.optional_workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $nango_integrations$
DECLARE data_schema text := current_schema(); owner_name text := current_user;
BEGIN
  -- Only the owner appends revisions (through the setter); no role may
  -- update or delete one, so the history stays append-only.
  EXECUTE format('CREATE POLICY owner_append ON integration_backend_revisions FOR INSERT TO %I WITH CHECK (true)', owner_name);
  -- Operators reconcile every organization's usage as the owner.
  EXECUTE format('CREATE POLICY owner_read ON nango_usage_events FOR SELECT TO %I USING (true)', owner_name);
  -- Native X accounts live in social_connections; the affected-users export
  -- reads them inside the same owner inventory window as connections.
  EXECUTE format(
    'CREATE POLICY nango_affected_inventory_read ON social_connections FOR SELECT TO %I USING (opengeni_private.organization_tenancy_inventory_capability_active())',
    owner_name
  );

  EXECUTE format($definition$
    CREATE FUNCTION set_integration_backend(
      p_integration_key text,
      p_backend text,
      p_provider_config_key text,
      p_enabled boolean,
      p_definition jsonb,
      p_changed_by text,
      p_reason text
    ) RETURNS bigint
    LANGUAGE plpgsql SECURITY INVOKER
    SET search_path = pg_catalog, %I, pg_temp
    AS $body$
    DECLARE written bigint;
    BEGIN
      IF p_backend IS NULL OR p_enabled IS NULL THEN
        RAISE EXCEPTION 'integration backend requires explicit backend and enabled values'
          USING ERRCODE = '22004';
      END IF;
      IF p_definition IS NOT NULL AND (
        jsonb_typeof(p_definition) <> 'object'
        OR p_definition - ARRAY['displayName', 'description', 'logoUrl', 'ownership',
          'accountIdentity', 'tools', 'scopes'] <> '{}'::jsonb
        OR (p_definition ? 'tools' AND (jsonb_typeof(p_definition->'tools') <> 'object'
          OR p_definition->'tools'->>'source' IS DISTINCT FROM 'nango'))
        -- Nango connections act as the person who connected them; shared
        -- (workspace-owned) Nango accounts are not supported.
        OR (p_definition ? 'ownership' AND p_definition->>'ownership' IS DISTINCT FROM 'personal')
      ) THEN
        RAISE EXCEPTION 'invalid integration definition' USING ERRCODE = '22023';
      END IF;
      -- Serializes revision order across simultaneous operator updates.
      PERFORM pg_advisory_xact_lock(hashtextextended('integration-backend:' || p_integration_key, 0));
      INSERT INTO integration_backend_revisions (
        integration_key, backend, nango_provider_config_key, enabled, definition, changed_by, reason
      ) VALUES (
        p_integration_key, p_backend, nullif(btrim(p_provider_config_key), ''), p_enabled,
        p_definition, btrim(p_changed_by), btrim(p_reason)
      ) RETURNING revision INTO written;
      RETURN written;
    END
    $body$
  $definition$, data_schema);

  EXECUTE format($definition$
    CREATE FUNCTION nango_affected_connections(p_integration_key text)
    RETURNS TABLE (
      organization_id uuid,
      organization_name text,
      workspace_id uuid,
      workspace_name text,
      user_id text,
      user_email text,
      connection_id uuid,
      backend text,
      provider_domain text,
      status text,
      account_label text,
      created_at timestamptz,
      last_used_at timestamptz,
      nango_connection_id text
    )
    LANGUAGE plpgsql VOLATILE SECURITY INVOKER
    SET search_path = pg_catalog, %I, pg_temp
    AS $body$
    DECLARE native_domain text;
    BEGIN
      native_domain := CASE p_integration_key
        WHEN 'gmail' THEN 'gmailmcp.googleapis.com'
        WHEN 'google-calendar' THEN 'calendarmcp.googleapis.com'
        WHEN 'google-drive' THEN 'drivemcp.googleapis.com'
        WHEN 'x' THEN 'x.com'
        ELSE NULL END;
      -- Owner inventory window: lets this transaction read connections of
      -- every organization, exactly like the tenancy inventory reports.
      INSERT INTO opengeni_private.organization_tenancy_inventory_capabilities (
        backend_pid, transaction_id
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id())
      ON CONFLICT DO NOTHING;
      RETURN QUERY
        SELECT * FROM (
        SELECT c.account_id, a.name, c.workspace_id, w.name,
          CASE WHEN c.subject_id LIKE 'user:%%' THEN substr(c.subject_id, 6) ELSE c.subject_id END,
          u.email, c.id,
          CASE WHEN c.provider_domain LIKE 'nango:%%' THEN 'nango' ELSE 'native' END,
          c.provider_domain, c.status,
          coalesce(c.metadata->>'accountEmail', c.metadata->>'accountLabel', c.metadata->>'email'),
          c.created_at, c.last_used_at, c.metadata->>'nangoConnectionId'
        FROM connections c
        JOIN workspaces w ON w.id = c.workspace_id AND w.account_id = c.account_id
        JOIN managed_accounts a ON a.id = c.account_id
        LEFT JOIN auth_users u ON c.subject_id = 'user:' || u.id
        WHERE c.provider_domain = 'nango:' || p_integration_key
          OR (native_domain IS NOT NULL AND c.provider_domain = native_domain)
        UNION ALL
        -- Native X accounts are social provider connections.
        SELECT s.account_id, a.name, s.workspace_id, w.name,
          CASE WHEN s.subject_id LIKE 'user:%%' THEN substr(s.subject_id, 6) ELSE s.subject_id END,
          u.email, s.id, 'native', 'x.com', s.status, s.account_handle,
          s.created_at, NULL::timestamptz, NULL::text
        FROM social_connections s
        JOIN workspaces w ON w.id = s.workspace_id AND w.account_id = s.account_id
        JOIN managed_accounts a ON a.id = s.account_id
        LEFT JOIN auth_users u ON s.subject_id = 'user:' || u.id
        WHERE p_integration_key = 'x' AND s.provider = 'x'
        ) affected
        ORDER BY 2, 4, 6, 12;
      DELETE FROM opengeni_private.organization_tenancy_inventory_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
    END
    $body$
  $definition$, data_schema);
END
$nango_integrations$;

REVOKE ALL ON FUNCTION set_integration_backend(text, text, text, boolean, jsonb, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION nango_affected_connections(text) FROM PUBLIC;

DO $nango_integrations_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    -- Exact grants, whatever the owner's default privileges gave the runtime.
    REVOKE ALL ON integration_backend_revisions, nango_usage_events FROM opengeni_app;
    GRANT SELECT ON integration_backend_revisions TO opengeni_app;
    REVOKE ALL ON integration_backends_effective FROM opengeni_app;
    GRANT SELECT ON integration_backends_effective TO opengeni_app;
    GRANT SELECT, INSERT ON nango_usage_events TO opengeni_app;
    REVOKE ALL ON FUNCTION set_integration_backend(text, text, text, boolean, jsonb, text, text) FROM opengeni_app;
    REVOKE ALL ON FUNCTION nango_affected_connections(text) FROM opengeni_app;
  END IF;
END
$nango_integrations_grants$;
