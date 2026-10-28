-- deployment-mode: rolling
-- A person can go Back after their organization exists and answer "How do
-- you want to use OpenGeni?" again, and the new-chat page follows the answer
-- on every device. Keep each person's current answer per organization here.
-- organization_signup_use_cases (0595) is unchanged: it still keeps the
-- first answer for analytics behind its record capability.
--
-- A new securely shaped table, so the previous release's forward-compatible
-- readiness accepts it: FORCE RLS to the tenant, one policy, ordinary row
-- grants (no DELETE) to the runtime roles, which never own it. The API writes
-- only for the authenticated managed human after proving their active
-- membership in the organization. The answer is a fixed value from a closed
-- list; no name, email, domain or free text is stored.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE opengeni_private.organization_signup_current_use_cases (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  subject_id text NOT NULL,
  use_case text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, subject_id),
  CONSTRAINT organization_signup_current_use_cases_use_case_check
    CHECK (use_case IN ('everyday', 'embed', 'cloud')),
  CONSTRAINT organization_signup_current_use_cases_subject_check
    CHECK (subject_id ~ '^user:[A-Za-z0-9_-]{1,255}$')
);
ALTER TABLE opengeni_private.organization_signup_current_use_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.organization_signup_current_use_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON opengeni_private.organization_signup_current_use_cases
  USING (account_id = opengeni_private.current_account_id())
  WITH CHECK (account_id = opengeni_private.current_account_id());
REVOKE ALL ON TABLE opengeni_private.organization_signup_current_use_cases FROM PUBLIC;

-- Effective grants, not default privileges: exactly row access for the
-- runtime roles that already write sessions; provisionRoles owns future roles.
DO $grants$
DECLARE target_schema text := current_schema(); recipient record;
BEGIN
  FOR recipient IN
    SELECT DISTINCT acl.grantee, r.rolname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) acl
      LEFT JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = 'opengeni_private' AND c.relname = 'organization_signup_current_use_cases'
      AND acl.grantee <> c.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE opengeni_private.organization_signup_current_use_cases FROM %s',
      CASE WHEN recipient.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(recipient.rolname) END);
  END LOOP;
  FOR recipient IN
    SELECT DISTINCT r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) acl JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = target_schema AND c.relname = 'sessions'
      AND acl.privilege_type = 'INSERT' AND acl.grantee <> c.relowner
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE opengeni_private.organization_signup_current_use_cases TO %I', recipient.rolname);
  END LOOP;
END $grants$;
