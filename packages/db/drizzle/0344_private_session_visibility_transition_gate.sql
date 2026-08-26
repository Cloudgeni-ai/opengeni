-- deployment-mode: rolling
-- A committed visibility transition replays from its applied command receipt
-- without issuing another sessions UPDATE. Gate the actual state change so
-- replay remains recoverable after an owner disables private sessions, while a
-- fresh shared-workspace transition fails closed. Personal workspaces retain
-- the same exemption as private create and private fork destinations.

-- Migration 0323's settings routines install this marker before reading the
-- actor membership, but the shared lifecycle policy never admitted it. Keep
-- this authority narrow and separate from that shared marker list. The UPDATE
-- policy is required because the mutating seam locks the actor with FOR SHARE.
DO $organization_private_session_settings_membership_policies$
DECLARE
  data_schema text := pg_catalog.current_schema();
  migration_owner text := current_user;
  marker constant text :=
    'current_setting(''opengeni.organization_tenancy_lifecycle'', true) '
      || '= ''organization_private_session_settings'' AND account_id = nullif('
      || 'current_setting(''opengeni.account_id'', true), '''')::uuid';
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY organization_private_session_settings_membership_read '
      || 'ON %I.organization_memberships FOR SELECT '
      || 'USING (current_user = %L AND %s)',
    data_schema, migration_owner, marker
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY organization_private_session_settings_membership_lock '
      || 'ON %I.organization_memberships FOR UPDATE '
      || 'USING (current_user = %L AND %s)',
    data_schema, migration_owner, marker
  );
END
$organization_private_session_settings_membership_policies$;

CREATE FUNCTION guard_private_session_visibility_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
BEGIN
  IF OLD.visibility IS DISTINCT FROM NEW.visibility
    AND NEW.visibility = 'user_private'
    AND NOT EXISTS (
      SELECT 1
      FROM organization_memberships membership
      WHERE membership.account_id = NEW.account_id
        AND membership.personal_workspace_id = NEW.workspace_id
        AND membership.status = 'active'
    )
    AND NOT organization_private_sessions_enabled(NEW.account_id)
  THEN
    RAISE EXCEPTION
      'private sessions are not enabled for this organization''s shared workspaces'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION guard_private_session_visibility_transition() FROM PUBLIC;

DROP TRIGGER IF EXISTS session_01_private_visibility_setting_fence ON sessions;
CREATE TRIGGER session_01_private_visibility_setting_fence
BEFORE UPDATE OF visibility ON sessions
FOR EACH ROW
WHEN (OLD.visibility IS DISTINCT FROM NEW.visibility AND NEW.visibility = 'user_private')
EXECUTE FUNCTION guard_private_session_visibility_transition();

DO $$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.guard_private_session_visibility_transition() '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema,
    data_schema
  );
END
$$;

COMMENT ON FUNCTION guard_private_session_visibility_transition() IS
  'Refuses a fresh transition to user_private in a shared workspace while the organization private-session setting is disabled; applied receipt replay performs no UPDATE and remains valid.';
