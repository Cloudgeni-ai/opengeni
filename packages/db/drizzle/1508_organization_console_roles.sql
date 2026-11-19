-- deployment-mode: rolling
-- Console roles for organization members (docs/opengeni-console.md, "Roles").
-- Owners and admins are always full in Console, from their organization role,
-- and have no row here. A member's Console role is none (no row, or 'none'),
-- 'viewer' or 'editor'. A row names either a member, by their `user:`
-- subject, or a pending invitation, whose role becomes the member's when they
-- accept it (`applied_at`). The FK keeps an invitation row in the
-- invitation's own organization.
--
-- Visibility, not authorization: the API checks that the caller is an owner
-- or admin of the organization before every write and resolves a reader's
-- role itself. Rows are visible to the organization's account context only
-- (and its workspace contexts, through account_rls_visible); the runtime may
-- read, insert and update them, never delete (setting 'none' clears a role).
-- A Console role never grants access to app workspaces.
--
-- Rolling: a new table the previous release never reads or writes;
-- organization memberships and invitations are unchanged.
SET LOCAL lock_timeout = '5s';

CREATE TABLE organization_console_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  subject_id text,
  invitation_id uuid,
  role text NOT NULL,
  applied_at timestamptz,
  updated_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_console_roles_subject_uq UNIQUE (account_id, subject_id),
  CONSTRAINT organization_console_roles_invitation_uq UNIQUE (account_id, invitation_id),
  CONSTRAINT organization_console_roles_invitation_fk FOREIGN KEY (invitation_id, account_id)
    REFERENCES organization_membership_invitations(id, account_id) ON DELETE CASCADE,
  CONSTRAINT organization_console_roles_check CHECK (
    role IN ('none', 'viewer', 'editor')
    AND (subject_id IS NULL) <> (invitation_id IS NULL)
    AND (subject_id IS NULL OR (subject_id LIKE 'user:%' AND octet_length(subject_id) BETWEEN 6 AND 1024))
    AND (applied_at IS NULL OR invitation_id IS NOT NULL)
    AND char_length(updated_by_subject_id) BETWEEN 1 AND 1024
  )
);
COMMENT ON TABLE organization_console_roles IS 'Console role (none, viewer, editor) of an organization member or pending invitation; owners and admins are always full. Never app workspace access.';

ALTER TABLE organization_console_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_console_roles FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE organization_console_roles FROM PUBLIC;
CREATE POLICY account_isolation ON organization_console_roles
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));

DO $organization_console_roles_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    -- Exact grants, whatever the owner's default privileges gave the runtime.
    REVOKE ALL ON organization_console_roles FROM opengeni_app;
    GRANT SELECT, INSERT, UPDATE ON organization_console_roles TO opengeni_app;
  END IF;
END
$organization_console_roles_grants$;
