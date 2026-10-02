-- deployment-mode: rolling
-- Deployment-level runtime switch for new managed account sign-ups, a sibling
-- of the 0521 verified-signup-trial switch. OPENGENI_MANAGED_AUTH_NEW_SIGNUPS_ENABLED
-- stays the master ceiling; while it allows sign-ups, the API also requires the
-- newest revision below to allow them before Better Auth creates a new user
-- (email sign-up or implicit Google/GitHub sign-up). The seed revision is open,
-- so this migration changes nothing until an operator calls
-- set_managed_auth_new_signups_enabled. A flip applies to the next sign-up
-- request on every API replica without a deploy or restart. Sign-in, sessions,
-- password reset, email verification, and invitation-bound account setup never
-- consult it.
SET LOCAL lock_timeout = '5s';

-- Append-only: every row is one audited switch revision, and the newest row is
-- the current state. Runtime roles get SELECT only (via provisionRoles) so the
-- API can read it; nothing but the owner-only setter below writes here.
CREATE TABLE opengeni_private.managed_auth_new_signups_switch_revisions (
  revision bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  signups_enabled boolean NOT NULL,
  previous_signups_enabled boolean,
  operator text NOT NULL CHECK (
    operator = pg_catalog.btrim(operator)
    AND pg_catalog.char_length(operator) BETWEEN 1 AND 200
  ),
  reason text NOT NULL CHECK (
    reason = pg_catalog.btrim(reason)
    AND pg_catalog.char_length(reason) BETWEEN 6 AND 1000
  ),
  database_role text NOT NULL DEFAULT session_user,
  changed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
REVOKE ALL ON opengeni_private.managed_auth_new_signups_switch_revisions FROM PUBLIC;

INSERT INTO opengeni_private.managed_auth_new_signups_switch_revisions (
  signups_enabled, previous_signups_enabled, operator, reason
) VALUES (
  true, NULL, 'migration:0585',
  'Initial state: new sign-ups are open; the deployment flag remains the master switch.'
);

CREATE FUNCTION reject_managed_auth_new_signups_switch_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
  RAISE EXCEPTION 'managed auth new signups switch revisions are append-only'
    USING ERRCODE = '55000';
END
$body$;
REVOKE ALL ON FUNCTION reject_managed_auth_new_signups_switch_revision_mutation() FROM PUBLIC;

CREATE TRIGGER managed_auth_new_signups_switch_revisions_immutable
BEFORE UPDATE OR DELETE ON opengeni_private.managed_auth_new_signups_switch_revisions
FOR EACH ROW EXECUTE FUNCTION reject_managed_auth_new_signups_switch_revision_mutation();
CREATE TRIGGER managed_auth_new_signups_switch_revisions_no_truncate
BEFORE TRUNCATE ON opengeni_private.managed_auth_new_signups_switch_revisions
FOR EACH STATEMENT EXECUTE FUNCTION reject_managed_auth_new_signups_switch_revision_mutation();

-- Operator-only audited setter. It lives in the data schema so its EXECUTE ACL
-- is not swept by the opengeni_private runtime grant; PUBLIC and every runtime
-- role stay revoked (provisionRoles converges late roles, and runtime posture
-- fails if either gains EXECUTE). The advisory lock serializes concurrent
-- operator calls so each audit row records the exact previous state.
CREATE FUNCTION set_managed_auth_new_signups_enabled(
  p_enabled boolean,
  p_operator text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
SET lock_timeout = '10s'
AS $body$
DECLARE
  previous_enabled boolean;
  written opengeni_private.managed_auth_new_signups_switch_revisions%ROWTYPE;
BEGIN
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'managed auth new signups switch requires an explicit enabled value'
      USING ERRCODE = '22023';
  END IF;
  IF p_operator IS NULL OR p_operator <> pg_catalog.btrim(p_operator)
    OR pg_catalog.char_length(p_operator) NOT BETWEEN 1 AND 200
  THEN
    RAISE EXCEPTION 'managed auth new signups switch operator must be 1-200 trimmed characters'
      USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR p_reason <> pg_catalog.btrim(p_reason)
    OR pg_catalog.char_length(p_reason) NOT BETWEEN 6 AND 1000
  THEN
    RAISE EXCEPTION 'managed auth new signups switch reason must be 6-1000 trimmed characters'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('managed-auth-new-signups-switch', 0)
  );
  SELECT revision.signups_enabled
  INTO previous_enabled
  FROM opengeni_private.managed_auth_new_signups_switch_revisions revision
  ORDER BY revision.revision DESC
  LIMIT 1;

  INSERT INTO opengeni_private.managed_auth_new_signups_switch_revisions (
    signups_enabled, previous_signups_enabled, operator, reason, database_role
  ) VALUES (
    p_enabled, previous_enabled, p_operator, p_reason, session_user
  )
  RETURNING * INTO written;

  RETURN pg_catalog.jsonb_build_object(
    'revision', written.revision,
    'signupsEnabled', written.signups_enabled,
    'previousSignupsEnabled', written.previous_signups_enabled,
    'changed', written.previous_signups_enabled IS DISTINCT FROM written.signups_enabled,
    'operator', written.operator,
    'reason', written.reason,
    'databaseRole', written.database_role,
    'changedAt', written.changed_at
  );
END
$body$;

REVOKE ALL ON FUNCTION set_managed_auth_new_signups_enabled(boolean, text, text) FROM PUBLIC;

-- REVOKE FROM PUBLIC leaves grants that out-of-band ALTER DEFAULT PRIVILEGES
-- gave named roles at CREATE time. Strip every non-owner grantee from the new
-- table and the setter so no runtime role can write the switch or call the
-- setter before db:provision-roles runs; provisioning then grants SELECT only.
DO $switch_acl$
DECLARE
  grantee_name text;
BEGIN
  FOR grantee_name IN
    SELECT DISTINCT role_row.rolname FROM pg_catalog.pg_class relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
      relation.relacl, pg_catalog.acldefault('r', relation.relowner)
    )) privilege
    JOIN pg_catalog.pg_roles role_row ON role_row.oid = privilege.grantee
    WHERE relation.oid = 'opengeni_private.managed_auth_new_signups_switch_revisions'::regclass
      AND privilege.grantee <> relation.relowner
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON TABLE opengeni_private.managed_auth_new_signups_switch_revisions FROM %I',
      grantee_name
    );
  END LOOP;
  FOR grantee_name IN
    SELECT DISTINCT role_row.rolname FROM pg_catalog.pg_proc routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
      routine.proacl, pg_catalog.acldefault('f', routine.proowner)
    )) privilege
    JOIN pg_catalog.pg_roles role_row ON role_row.oid = privilege.grantee
    WHERE routine.oid = 'set_managed_auth_new_signups_enabled(boolean, text, text)'::regprocedure
      AND privilege.grantee <> routine.proowner
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION %I.set_managed_auth_new_signups_enabled(boolean, text, text) FROM %I',
      pg_catalog.current_schema(),
      grantee_name
    );
  END LOOP;
END
$switch_acl$;

DO $posture$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.set_managed_auth_new_signups_enabled(boolean, text, text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema,
    data_schema
  );
END
$posture$;
