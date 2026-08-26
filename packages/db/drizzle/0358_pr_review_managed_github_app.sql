-- deployment-mode: rolling
-- A deployment-owned, least-privilege GitHub App can be installed through the
-- same owner-proof browser flow as the platform App. Workspace registrations
-- reference that managed identity rather than copying its private key. The
-- credential-free route table resolves an already-authenticated GitHub
-- delivery to one exact Pack source and repository binding.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE pr_review_app_registrations
  ADD COLUMN installation_id text,
  ADD COLUMN provider_account_login text,
  ADD COLUMN provider_account_type text,
  ADD COLUMN github_actor_id text,
  ADD COLUMN authority_kind text,
  ADD COLUMN authority_checked_at timestamptz,
  ADD COLUMN authority_expires_at timestamptz,
  ADD COLUMN authority_nonce text;

ALTER TABLE pr_review_app_registrations
  DROP CONSTRAINT pr_review_app_registrations_credential_chk;

ALTER TABLE pr_review_app_registrations
  ADD CONSTRAINT pr_review_app_registrations_credential_chk CHECK (
    (provider = 'github' AND credential_kind = 'github_app'
      AND credential_encrypted IS NOT NULL AND app_id IS NOT NULL
      AND installation_id IS NULL)
    OR
    (provider = 'github' AND credential_kind = 'managed_github_app'
      AND credential_encrypted IS NULL AND app_id IS NOT NULL
      AND installation_id IS NOT NULL
      AND provider_account_type IN ('User', 'Organization')
      AND github_actor_id ~ '^[1-9][0-9]*$'
      AND authority_kind IN ('personal_owner', 'organization_owner')
      AND authority_checked_at IS NOT NULL
      AND authority_expires_at IS NOT NULL
      AND authority_expires_at > authority_checked_at
      AND octet_length(authority_nonce) BETWEEN 16 AND 256)
    OR
    (provider IN ('gitlab', 'azure_devops') AND credential_kind = 'provider_token'
      AND credential_encrypted IS NOT NULL AND installation_id IS NULL)
  );

CREATE UNIQUE INDEX pr_review_managed_github_workspace_installation_uq
  ON pr_review_app_registrations (workspace_id, installation_id)
  WHERE credential_kind = 'managed_github_app';

CREATE UNIQUE INDEX pr_review_managed_github_authority_nonce_uq
  ON pr_review_app_registrations (authority_nonce)
  WHERE authority_nonce IS NOT NULL;

-- Append-only consumption receipts keep every successful OAuth state
-- single-use even after the registration advances to a newer authority proof.
CREATE TABLE pr_review_managed_github_authority_nonces (
  authority_nonce text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  installation_id text NOT NULL,
  authority_expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pr_review_managed_github_authority_nonces_workspace_account_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT pr_review_managed_github_authority_nonces_identity_chk CHECK (
    octet_length(authority_nonce) BETWEEN 16 AND 256
    AND installation_id ~ '^[1-9][0-9]*$'
    AND authority_expires_at > consumed_at
  )
);

ALTER TABLE pr_review_managed_github_authority_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_review_managed_github_authority_nonces FORCE ROW LEVEL SECURITY;
CREATE POLICY pr_review_managed_github_authority_nonces_tenant
  ON pr_review_managed_github_authority_nonces
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

-- Credential-free global routing only. The shared webhook secret is verified
-- over the bounded raw body before these provider ids are parsed or resolved;
-- the FORCE-RLS source, trigger, Pack installation, and binding remain the
-- acceptance and dispatch authorities.
CREATE TABLE pr_review_managed_github_routes (
  binding_id uuid PRIMARY KEY REFERENCES pr_review_repository_bindings(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  registration_id uuid NOT NULL,
  source_id uuid NOT NULL,
  installation_id text NOT NULL,
  provider_repository_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pr_review_managed_github_routes_workspace_account_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT pr_review_managed_github_routes_registration_fk
    FOREIGN KEY (workspace_id, registration_id)
    REFERENCES pr_review_app_registrations(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT pr_review_managed_github_routes_source_fk
    FOREIGN KEY (workspace_id, source_id)
    REFERENCES automation_sources(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT pr_review_managed_github_routes_identity_chk CHECK (
    installation_id ~ '^[1-9][0-9]*$'
    AND provider_repository_id ~ '^[1-9][0-9]*$'
  )
);

CREATE UNIQUE INDEX pr_review_managed_github_route_identity_uq
  ON pr_review_managed_github_routes (installation_id, provider_repository_id);
