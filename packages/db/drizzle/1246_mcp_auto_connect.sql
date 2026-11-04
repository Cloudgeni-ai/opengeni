-- deployment-mode: rolling
-- MCP auto-connect (Enterprise-Managed Authorization, ID-JAG) in both directions.
--
-- Inbound: an organization trusts an identity issuer (Claude's per-organization
-- issuer, or its own identity provider). An MCP client redeems an ID-JAG that
-- issuer signed at /oauth/token and its member is connected to the
-- organization MCP server with no sign-in screen.
-- * organization_mcp_trusted_issuers: the issuers an organization trusts and
--   the access every app connected through one gets.
-- * organization_mcp_trusted_issuer_subjects: who each issuer has connected
--   (its stable subject, linked to the member it matched).
-- * organization_mcp_trusted_issuer_events: recent attempts, refusals included,
--   so an admin can see why a setup is not working yet.
-- * organization_mcp_assertion_replays: each ID-JAG is redeemed once.
-- * mcp_oauth_refresh_tokens.trusted_issuer_id/assertion_subject: an
--   auto-connected agent is one connection (refresh family) whose anchor row
--   carries no usable refresh token.
--
-- Outbound: Opengeni is the issuer.
-- * organization_identity_issuers: the organization's signing key. The public
--   half is served as the issuer's key set; the private half is stored
--   encrypted under the environments key, like other credentials.
--
-- Row security. The token endpoint runs before anyone is known: it names the
-- one issuer an ID-JAG claims in `opengeni.mcp_assertion_issuer` and sees only
-- the active rows trusting it (the share-link lane's pattern; RLS is never
-- disabled). Everything after that runs in the matched organization's
-- context. Only an organization owner or admin, with no workspace, changes the
-- trusted issuers or creates the signing key.
--
-- Rolling: new tables the previous release never reads or writes, and two
-- nullable columns it never selects.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE organization_mcp_trusted_issuers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  provider text NOT NULL,
  issuer text NOT NULL,
  jwks_uri text,
  allowed_client_ids jsonb,
  organization_access jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_by_subject_id text NOT NULL,
  updated_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_mcp_trusted_issuers_values_chk CHECK (
    char_length(name) BETWEEN 1 AND 80
    AND provider IN ('claude', 'okta', 'other')
    AND status IN ('active', 'disabled')
    AND char_length(issuer) BETWEEN 8 AND 2048
    AND (jwks_uri IS NULL OR char_length(jwks_uri) BETWEEN 8 AND 2048)
    AND (allowed_client_ids IS NULL OR jsonb_typeof(allowed_client_ids) = 'array')
    AND jsonb_typeof(organization_access) = 'object'
    AND char_length(created_by_subject_id) BETWEEN 1 AND 300
    AND char_length(updated_by_subject_id) BETWEEN 1 AND 300
  ),
  CONSTRAINT organization_mcp_trusted_issuers_issuer_key UNIQUE (account_id, issuer)
);
CREATE INDEX organization_mcp_trusted_issuers_issuer_idx
  ON organization_mcp_trusted_issuers (issuer) WHERE status = 'active';

CREATE TABLE organization_mcp_trusted_issuer_subjects (
  trusted_issuer_id uuid NOT NULL REFERENCES organization_mcp_trusted_issuers(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  assertion_subject text NOT NULL,
  subject_id text NOT NULL,
  email text,
  first_connected_at timestamptz NOT NULL DEFAULT now(),
  last_connected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trusted_issuer_id, assertion_subject),
  CONSTRAINT organization_mcp_trusted_issuer_subjects_values_chk CHECK (
    char_length(assertion_subject) BETWEEN 1 AND 1024
    AND char_length(subject_id) BETWEEN 1 AND 1024
    AND (email IS NULL OR char_length(email) BETWEEN 3 AND 320)
  )
);
CREATE INDEX organization_mcp_trusted_issuer_subjects_account_idx
  ON organization_mcp_trusted_issuer_subjects (account_id, trusted_issuer_id);

CREATE TABLE organization_mcp_trusted_issuer_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trusted_issuer_id uuid NOT NULL REFERENCES organization_mcp_trusted_issuers(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  outcome text NOT NULL,
  reason text,
  subject_id text,
  email text,
  client_id text,
  client_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_mcp_trusted_issuer_events_values_chk CHECK (
    outcome IN ('connected', 'refused')
    AND (outcome = 'refused') = (reason IS NOT NULL)
    AND (reason IS NULL OR char_length(reason) BETWEEN 1 AND 64)
    AND (subject_id IS NULL OR char_length(subject_id) BETWEEN 1 AND 1024)
    AND (email IS NULL OR char_length(email) BETWEEN 1 AND 320)
    AND (client_id IS NULL OR char_length(client_id) BETWEEN 1 AND 2048)
    AND (client_name IS NULL OR char_length(client_name) BETWEEN 1 AND 200)
  )
);
CREATE INDEX organization_mcp_trusted_issuer_events_recent_idx
  ON organization_mcp_trusted_issuer_events (trusted_issuer_id, created_at DESC);

CREATE TABLE organization_mcp_assertion_replays (
  trusted_issuer_id uuid NOT NULL REFERENCES organization_mcp_trusted_issuers(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  jti_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (trusted_issuer_id, jti_hash),
  CONSTRAINT organization_mcp_assertion_replays_values_chk CHECK (jti_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX organization_mcp_assertion_replays_expires_idx
  ON organization_mcp_assertion_replays (account_id, expires_at);

CREATE TABLE organization_identity_issuers (
  account_id uuid PRIMARY KEY REFERENCES managed_accounts(id) ON DELETE CASCADE,
  key_id text NOT NULL,
  algorithm text NOT NULL,
  public_jwk jsonb NOT NULL,
  private_key_encrypted text NOT NULL,
  created_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_identity_issuers_values_chk CHECK (
    key_id ~ '^[A-Za-z0-9_-]{16,64}$'
    AND algorithm IN ('RS256', 'ES256')
    AND jsonb_typeof(public_jwk) = 'object'
    AND char_length(private_key_encrypted) BETWEEN 1 AND 16384
    AND char_length(created_by_subject_id) BETWEEN 1 AND 300
  )
);

ALTER TABLE mcp_oauth_refresh_tokens
  ADD COLUMN trusted_issuer_id uuid,
  ADD COLUMN assertion_subject text;
ALTER TABLE mcp_oauth_refresh_tokens
  ADD CONSTRAINT mcp_oauth_refresh_tokens_assertion_chk CHECK (
    (trusted_issuer_id IS NULL) = (assertion_subject IS NULL)
    AND (assertion_subject IS NULL OR char_length(assertion_subject) BETWEEN 1 AND 1024)
  ) NOT VALID;
-- 1247 validates the check and 1248 builds its index concurrently.

-- Row security ---------------------------------------------------------------

ALTER TABLE organization_mcp_trusted_issuers ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_mcp_trusted_issuers FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE organization_mcp_trusted_issuers FROM PUBLIC;
CREATE POLICY organization_mcp_trusted_issuers_scope ON organization_mcp_trusted_issuers
  USING (
    account_id = opengeni_private.current_account_id()
    AND opengeni_private.current_workspace_id() IS NULL
  )
  WITH CHECK (
    account_id = opengeni_private.current_account_id()
    AND opengeni_private.current_workspace_id() IS NULL
  );
-- The token endpoint's lane: exactly the active rows trusting the one issuer
-- this transaction named.
CREATE POLICY organization_mcp_trusted_issuers_issuer_lookup ON organization_mcp_trusted_issuers
  FOR SELECT
  USING (
    issuer = nullif(pg_catalog.current_setting('opengeni.mcp_assertion_issuer', true), '')
    AND status = 'active'
  );
CREATE POLICY organization_mcp_trusted_issuers_admin_insert ON organization_mcp_trusted_issuers
  AS RESTRICTIVE FOR INSERT WITH CHECK (
    opengeni_private.codex_organization_admin_visible(account_id)
  );
CREATE POLICY organization_mcp_trusted_issuers_admin_update ON organization_mcp_trusted_issuers
  AS RESTRICTIVE FOR UPDATE
  USING (opengeni_private.codex_organization_admin_visible(account_id))
  WITH CHECK (opengeni_private.codex_organization_admin_visible(account_id));
CREATE POLICY organization_mcp_trusted_issuers_admin_delete ON organization_mcp_trusted_issuers
  AS RESTRICTIVE FOR DELETE USING (
    opengeni_private.codex_organization_admin_visible(account_id)
  );

ALTER TABLE organization_mcp_trusted_issuer_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_mcp_trusted_issuer_subjects FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE organization_mcp_trusted_issuer_subjects FROM PUBLIC;
CREATE POLICY organization_mcp_trusted_issuer_subjects_scope
  ON organization_mcp_trusted_issuer_subjects
  USING (
    account_id = opengeni_private.current_account_id()
    AND opengeni_private.current_workspace_id() IS NULL
  )
  WITH CHECK (
    account_id = opengeni_private.current_account_id()
    AND opengeni_private.current_workspace_id() IS NULL
  );

ALTER TABLE organization_mcp_trusted_issuer_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_mcp_trusted_issuer_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE organization_mcp_trusted_issuer_events FROM PUBLIC;
CREATE POLICY organization_mcp_trusted_issuer_events_scope
  ON organization_mcp_trusted_issuer_events
  USING (
    account_id = opengeni_private.current_account_id()
    AND opengeni_private.current_workspace_id() IS NULL
  )
  WITH CHECK (
    account_id = opengeni_private.current_account_id()
    AND opengeni_private.current_workspace_id() IS NULL
  );

ALTER TABLE organization_mcp_assertion_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_mcp_assertion_replays FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE organization_mcp_assertion_replays FROM PUBLIC;
CREATE POLICY organization_mcp_assertion_replays_scope ON organization_mcp_assertion_replays
  USING (
    account_id = opengeni_private.current_account_id()
    AND opengeni_private.current_workspace_id() IS NULL
  )
  WITH CHECK (
    account_id = opengeni_private.current_account_id()
    AND opengeni_private.current_workspace_id() IS NULL
  );

ALTER TABLE organization_identity_issuers ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_identity_issuers FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE organization_identity_issuers FROM PUBLIC;
-- Read in the organization's own context: its public key set is public, and
-- members' connections are signed with it.
CREATE POLICY organization_identity_issuers_scope ON organization_identity_issuers
  USING (account_id = opengeni_private.current_account_id())
  WITH CHECK (account_id = opengeni_private.current_account_id());
CREATE POLICY organization_identity_issuers_admin_insert ON organization_identity_issuers
  AS RESTRICTIVE FOR INSERT WITH CHECK (
    opengeni_private.codex_organization_admin_visible(account_id)
  );
CREATE POLICY organization_identity_issuers_admin_update ON organization_identity_issuers
  AS RESTRICTIVE FOR UPDATE
  USING (opengeni_private.codex_organization_admin_visible(account_id))
  WITH CHECK (opengeni_private.codex_organization_admin_visible(account_id));
CREATE POLICY organization_identity_issuers_admin_delete ON organization_identity_issuers
  AS RESTRICTIVE FOR DELETE USING (
    opengeni_private.codex_organization_admin_visible(account_id)
  );

DO $mcp_auto_connect_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON organization_mcp_trusted_issuers TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON organization_mcp_trusted_issuer_subjects TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON organization_mcp_trusted_issuer_events TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON organization_mcp_assertion_replays TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON organization_identity_issuers TO opengeni_app;
  END IF;
END
$mcp_auto_connect_grants$;
