-- deployment-mode: rolling
-- An app that acts for its users with an organization key can now state a
-- user's workspace membership on each request (the optional `membership` of
-- the external actor header). Opengeni then makes the user's member grant in
-- that workspace exactly the stated permissions before authorizing the
-- request. Removing a member stays an explicit revoke by the app, and a revoke
-- must win over any request Opengeni authenticated before it, even when that
-- request reaches its membership write after the revoke.
--
-- This table is that ordering marker: one row per external member and
-- workspace, stamped from a sequence each time the member is removed.
-- Request authentication and revokes both run under the organization
-- membership fence (an advisory lock), so a request reads the sequence's last
-- value under the fence when it authenticates, and its membership write, also
-- under the fence, refuses to recreate or change a member whose revocation
-- number is higher. The sequence keeps CACHE 1 so values are handed out in
-- fence order across connections.
--
-- A new table and sequence that the previous release never reads or writes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE SEQUENCE external_workspace_member_revocation_seq AS bigint CACHE 1;

CREATE TABLE external_workspace_member_revocations (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  subject_id text NOT NULL,
  revocation_sequence bigint NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT external_workspace_member_revocations_pkey
    PRIMARY KEY (account_id, workspace_id, subject_id),
  CONSTRAINT external_workspace_member_revocations_workspace_fkey
    FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT external_workspace_member_revocations_values_chk CHECK (
    subject_id ~ '^external_user:[0-9a-f-]{36}$' AND revocation_sequence > 0
  )
);

ALTER TABLE external_workspace_member_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_workspace_member_revocations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE external_workspace_member_revocations FROM PUBLIC;
REVOKE ALL ON SEQUENCE external_workspace_member_revocation_seq FROM PUBLIC;
CREATE POLICY workspace_isolation ON external_workspace_member_revocations
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $external_workspace_member_revocations_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE ON external_workspace_member_revocations TO opengeni_app;
    GRANT SELECT, USAGE ON SEQUENCE external_workspace_member_revocation_seq TO opengeni_app;
  END IF;
END
$external_workspace_member_revocations_grants$;
