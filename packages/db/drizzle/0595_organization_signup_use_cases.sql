-- deployment-mode: rolling
-- The post-signup onboarding asks a new organization owner how they want to
-- use OpenGeni: add AI agents to their product (`embed`) or run agents in the
-- cloud (`cloud`). Keep that answer durably, per person and organization, so
-- later product work (for example lifecycle email) can read it.
--
-- New storage lives in opengeni_private behind one runtime capability, so the
-- public-schema table inventory of older binaries is unchanged and an older
-- API simply never calls it. The answer is a fixed value from a closed list;
-- no name, email, domain or free text is stored. The first answer wins: a
-- replayed or repeated record returns the stored choice instead of changing
-- it. The API records only for the authenticated managed human who holds a
-- membership grant in this organization; the database fences the tenant GUC
-- and the subject shape.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE opengeni_private.organization_signup_use_cases (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  subject_id text NOT NULL,
  use_case text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, subject_id),
  CONSTRAINT organization_signup_use_cases_use_case_check CHECK (use_case IN ('embed', 'cloud')),
  CONSTRAINT organization_signup_use_cases_subject_check CHECK (
    subject_id ~ '^user:[A-Za-z0-9_-]{1,255}$'
  )
);
ALTER TABLE opengeni_private.organization_signup_use_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.organization_signup_use_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON opengeni_private.organization_signup_use_cases
  USING (account_id = opengeni_private.current_account_id())
  WITH CHECK (account_id = opengeni_private.current_account_id());

-- Runtime roles have EXECUTE only, never table DML, so a stored answer can be
-- neither rewritten nor read for another organization.
CREATE FUNCTION opengeni_private.record_organization_signup_use_case(
  p_account uuid, p_subject text, p_use_case text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$
DECLARE v_use_case text;
BEGIN
  IF p_account IS NULL OR p_subject IS NULL OR p_use_case IS NULL
    OR p_account IS DISTINCT FROM opengeni_private.current_account_id()
  THEN RAISE EXCEPTION 'signup use case scope mismatch' USING ERRCODE = '42501'; END IF;
  IF p_subject !~ '^user:[A-Za-z0-9_-]{1,255}$' THEN
    RAISE EXCEPTION 'signup use case belongs to a managed person' USING ERRCODE = '42501';
  END IF;
  IF p_use_case NOT IN ('embed', 'cloud') THEN
    RAISE EXCEPTION 'invalid signup use case' USING ERRCODE = '22023';
  END IF;
  INSERT INTO opengeni_private.organization_signup_use_cases (account_id, subject_id, use_case)
  VALUES (p_account, p_subject, p_use_case)
  ON CONFLICT (account_id, subject_id) DO NOTHING;
  SELECT u.use_case INTO v_use_case
  FROM opengeni_private.organization_signup_use_cases u
  WHERE u.account_id = p_account AND u.subject_id = p_subject;
  RETURN v_use_case;
END $body$;
REVOKE ALL ON FUNCTION opengeni_private.record_organization_signup_use_case(uuid,text,text) FROM PUBLIC;

-- Preserve existing runtime role recipients; provisionRoles owns future roles.
DO $grants$
DECLARE target_schema text := current_schema(); recipient record;
BEGIN
  -- Explicit pg_temp LAST is load-bearing: omitting it lets PostgreSQL search
  -- caller-controlled temporary relations ahead of the captured data schema.
  EXECUTE format('ALTER FUNCTION opengeni_private.record_organization_signup_use_case(uuid,text,text) SET search_path = pg_catalog, %I, pg_temp', target_schema);
  FOR recipient IN
    SELECT DISTINCT acl.grantee, r.rolname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) acl
      LEFT JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = 'opengeni_private' AND c.relname = 'organization_signup_use_cases'
      AND acl.grantee <> c.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE opengeni_private.organization_signup_use_cases FROM %s',
      CASE WHEN recipient.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(recipient.rolname) END);
  END LOOP;
  FOR recipient IN
    SELECT DISTINCT acl.grantee, r.rolname, p.oid::regprocedure AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(p.proacl) acl LEFT JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = 'opengeni_private'
      AND p.proname = 'record_organization_signup_use_case'
      AND acl.grantee <> p.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', recipient.signature,
      CASE WHEN recipient.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(recipient.rolname) END);
  END LOOP;
  -- The runtime roles are exactly those that already write sessions.
  FOR recipient IN
    SELECT DISTINCT r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) acl JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = target_schema AND c.relname = 'sessions'
      AND acl.privilege_type = 'INSERT' AND acl.grantee <> c.relowner
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.record_organization_signup_use_case(uuid,text,text) TO %I', recipient.rolname);
  END LOOP;
END $grants$;
