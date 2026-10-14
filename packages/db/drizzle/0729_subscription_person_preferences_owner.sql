-- deployment-mode: rolling
-- A person's own subscription preferences (design
-- docs/design/subscription-core-2026-10-07.md, "M5: personal accounts and
-- explicit choice"; contract SUB-SEL-02 and D-27).
--
-- `subscription_person_preferences` holds one row per organization
-- membership with the person's personal-fallback opt-in. Until now only the
-- placement path could read it (the `subscription_person_preferences_scope`
-- policy admits a row only inside an accepted turn's runtime capability), and
-- nothing let the person themselves read or change it. This migration adds
-- the owner's own access and nothing else:
--
-- 1. `opengeni_private.subscription_own_person_membership_id(account)`:
--    the id of the caller's own active human (`user:` subject) membership
--    in the caller's `opengeni.account_id` scope, or null. Runtime roles
--    cannot read organization_memberships directly, so this SECURITY
--    DEFINER routine answers only this one question about the caller.
--    organization_memberships is FORCE row security and the documented
--    migration owner has no BYPASSRLS, so the routine reads it through a
--    dedicated owner-only SELECT policy
--    (`subscription_own_person_membership_read`): it applies only to the
--    migration owner while the transaction-local marker
--    `opengeni.organization_tenancy_lifecycle =
--    'subscription_own_person_membership'` is set, and only to the caller's
--    own row (`opengeni.account_id` and `opengeni.subject_id`). The routine
--    sets the marker immediately before its single SELECT and restores the
--    caller's value right after it (0349's and 0726's pattern); the marker
--    enables no write.
--    `opengeni_private.subscription_person_preference_owned(account,
--    membership)` is true only when the membership is that one.
-- 2. Three permissive policies (SELECT, INSERT, UPDATE) admitting exactly
--    those rows. They widen nothing for anyone else: another member, an
--    administrator, a service actor or an agent without a human subject
--    still sees and writes no row of this person. DELETE stays refused
--    (turning the opt-in off is an UPDATE), so the row's version keeps
--    counting for compare-and-swap writers.
--
-- Rolling: no column, routine or existing policy changes, so older binaries
-- read and write exactly what they did before. The placement path keeps
-- its own policy and still reads the opt-in only for the session owner's
-- membership under the accepted turn's capability.
SET LOCAL lock_timeout = '5s';

DO $subscription_own_person_membership_policy$
DECLARE
  data_schema text := pg_catalog.current_schema();
  migration_owner text := current_user;
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY subscription_own_person_membership_read '
      || 'ON %I.organization_memberships FOR SELECT USING ('
      || 'current_user = %L '
      || 'AND current_setting(''opengeni.organization_tenancy_lifecycle'', true) '
      || '= ''subscription_own_person_membership'' '
      || 'AND account_id = nullif(current_setting(''opengeni.account_id'', true), '''')::uuid '
      || 'AND subject_id = opengeni_private.current_subject_id())',
    data_schema, migration_owner
  );
END
$subscription_own_person_membership_policy$;

CREATE FUNCTION opengeni_private.subscription_own_person_membership_id(
  p_account_id uuid
) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  previous_lifecycle text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
  own_membership_id uuid;
BEGIN
  IF p_account_id IS NULL
    OR p_account_id::text IS DISTINCT FROM
      nullif(pg_catalog.current_setting('opengeni.account_id', true), '')
  THEN
    RETURN NULL;
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'subscription_own_person_membership', true
  );
  SELECT membership.id INTO own_membership_id FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = nullif(pg_catalog.current_setting('opengeni.subject_id', true), '')
    AND membership.subject_id LIKE 'user:%'
    AND membership.status = 'active' AND membership.revoked_at IS NULL
  LIMIT 1;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RETURN own_membership_id;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
  );
  RAISE;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.subscription_own_person_membership_id(uuid) FROM PUBLIC;

CREATE FUNCTION opengeni_private.subscription_person_preference_owned(
  p_account_id uuid, p_membership_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
  SELECT p_membership_id IS NOT NULL
    AND p_membership_id = opengeni_private.subscription_own_person_membership_id(p_account_id)
$body$;
REVOKE ALL ON FUNCTION opengeni_private.subscription_person_preference_owned(uuid, uuid) FROM PUBLIC;

-- Pin the routine to the data schema with pg_temp last, so a session's
-- temporary table cannot shadow organization_memberships.
DO $subscription_person_preference_owned_search_path$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.subscription_own_person_membership_id(uuid) SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema);
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.subscription_person_preference_owned(uuid, uuid) SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema);
END
$subscription_person_preference_owned_search_path$;

CREATE POLICY subscription_person_preferences_owner_read ON subscription_person_preferences
  FOR SELECT
  USING (opengeni_private.subscription_person_preference_owned(account_id, organization_membership_id));
CREATE POLICY subscription_person_preferences_owner_insert ON subscription_person_preferences
  FOR INSERT
  WITH CHECK (opengeni_private.subscription_person_preference_owned(account_id, organization_membership_id));
CREATE POLICY subscription_person_preferences_owner_update ON subscription_person_preferences
  FOR UPDATE
  USING (opengeni_private.subscription_person_preference_owned(account_id, organization_membership_id))
  WITH CHECK (opengeni_private.subscription_person_preference_owned(account_id, organization_membership_id));

-- Every configured application role (not only the default name) holds
-- EXECUTE before provision-roles, so an older binary's posture check stays
-- clean (0715's pattern). The routines answer only for the caller's own
-- scope and subject.
DO $grant_runtime$
DECLARE
  application_role text;
BEGIN
  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
    UNION SELECT 'opengeni_app'
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.subscription_own_person_membership_id(uuid) TO %I',
      application_role);
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.subscription_person_preference_owned(uuid, uuid) TO %I',
      application_role);
  END LOOP;
END
$grant_runtime$;
