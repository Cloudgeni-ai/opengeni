-- deployment-mode: rolling
-- Every member of an organization can see who else is in it, by name. Owners
-- and admins keep the full directory (list_organization_administration_members:
-- emails, roles, status and workspace access); this is the names-only view
-- for everyone else.
--
-- opengeni_private.list_organization_member_names_v1(account) returns, for
-- the transaction's own organization only, each active person's membership
-- id, display name and whether it is the caller. Nothing else: no email,
-- role, status, subject or workspace. It refuses unless the account is the
-- transaction's opengeni.account_id and the transaction's opengeni.subject_id
-- is a person ("user:") with an active owner, admin or member membership
-- there. Product users (external_user:) and services or keys are never
-- listed, and suspended, revoked or provisioning memberships are left out.
--
-- The function reads organization_memberships under the lifecycle marker the
-- administrator listing uses, and puts the caller's marker back before it
-- returns, so the marker never outlives the call.
--
-- As 0937, 0978 and 1060 explain, the previous release rejects a runtime
-- EXECUTE grant on a definer it doesn't know, so this migration grants
-- nothing: until a later migration grants it, the API reports the names list
-- as not available and members see what they saw before.
SET LOCAL lock_timeout = '5s';

DO $organization_member_names$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.list_organization_member_names_v1(p_account_id uuid)
    RETURNS jsonb
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      uuid_pattern constant text :=
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
      context_account text := nullif(pg_catalog.current_setting('opengeni.account_id', true), '');
      context_subject text := nullif(pg_catalog.current_setting('opengeni.subject_id', true), '');
      previous_marker text :=
        pg_catalog.current_setting('opengeni.organization_tenancy_lifecycle', true);
      result jsonb;
    BEGIN
      IF p_account_id IS NULL
        OR context_account IS NULL OR context_account !~ uuid_pattern
        OR context_account::uuid <> p_account_id
        OR context_subject IS NULL OR pg_catalog.left(context_subject, 5) <> 'user:'
      THEN
        RAISE EXCEPTION 'organization member authority required' USING ERRCODE = '42501';
      END IF;
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
      );
      IF NOT EXISTS (
        SELECT 1 FROM organization_memberships actor
        WHERE actor.account_id = p_account_id
          AND actor.subject_id = context_subject
          AND actor.status = 'active'
          AND actor.revoked_at IS NULL
          AND actor.role IN ('owner', 'admin', 'member')
      ) THEN
        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true
        );
        RAISE EXCEPTION 'organization membership required' USING ERRCODE = '42501';
      END IF;
      IF (SELECT pg_catalog.count(*) FROM organization_memberships membership
        WHERE membership.account_id = p_account_id
          AND membership.status = 'active'
          AND membership.revoked_at IS NULL
          AND pg_catalog.left(membership.subject_id, 5) = 'user:') > 1000
      THEN
        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true
        );
        RAISE EXCEPTION 'organization member inventory exceeds the bounded projection'
          USING ERRCODE = '54000';
      END IF;
      SELECT coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', membership.id,
          -- Capped at the API's 1024 characters, so one long name can't fail the list.
          'name', pg_catalog.left(nullif(pg_catalog.btrim(auth_user.name), ''), 1024),
          'you', membership.subject_id = context_subject
        ) ORDER BY pg_catalog.lower(nullif(pg_catalog.btrim(auth_user.name), '')) NULLS LAST,
          membership.id
      ), '[]'::jsonb) INTO result
      FROM organization_memberships membership
      LEFT JOIN auth_users auth_user ON membership.subject_id = 'user:' || auth_user.id
      WHERE membership.account_id = p_account_id
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
        AND pg_catalog.left(membership.subject_id, 5) = 'user:';
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true
      );
      RETURN result;
    END
    $body$
  $definition$, data_schema);
END
$organization_member_names$;

REVOKE ALL ON FUNCTION opengeni_private.list_organization_member_names_v1(uuid) FROM PUBLIC;
