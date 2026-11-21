-- deployment-mode: rolling
-- Per-connection MCP rate limits shared by every API process
-- (docs/mcp-surfaces.md): one token bucket per connected agent and budget,
-- keyed by a SHA-256 of the budget name and the connection key, in the
-- organization's account context. Rows hold no actor, tool or argument and
-- grant no authority.
--
-- Rolling: a new FORCE-RLS table with a policy, which the previous release's
-- posture check tolerates. That release limits in process memory and never
-- reads it.
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS mcp_connection_rate_limits (
    account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
    scope_hash text NOT NULL,
    tokens double precision NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT mcp_connection_rate_limits_pkey PRIMARY KEY (account_id, scope_hash),
    CONSTRAINT mcp_connection_rate_limits_scope_hash_check CHECK ((scope_hash ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE mcp_connection_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_connection_rate_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON mcp_connection_rate_limits
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));

REVOKE ALL ON TABLE mcp_connection_rate_limits FROM PUBLIC;
DO $opengeni_mcp_rate_limit_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON TABLE mcp_connection_rate_limits FROM opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mcp_connection_rate_limits TO opengeni_app;
  END IF;
END
$opengeni_mcp_rate_limit_grants$;
