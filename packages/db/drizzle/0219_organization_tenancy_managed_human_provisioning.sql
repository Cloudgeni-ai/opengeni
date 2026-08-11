-- deployment-mode: rolling
-- Activate only the managed-human provisioning seam for organization tenancy.
-- This migration does not expose organization/member CRUD, resource authority or
-- grant writes, session sharing, or personal-workspace runtime access.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- Keep all four Slice A tables FORCE-RLS and replace the inert deny-all policy
-- with one transaction-local capability marker. The marker is set only inside
-- the exact SECURITY DEFINER lifecycle routine below; opengeni_app still has
-- no direct table privileges on any of these tables.
DROP POLICY IF EXISTS organization_tenancy_system_only ON "organization_memberships";
CREATE POLICY organization_tenancy_lifecycle ON "organization_memberships"
  USING (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      = 'managed_human_provisioning'
  )
  WITH CHECK (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      = 'managed_human_provisioning'
  );

DROP POLICY IF EXISTS organization_tenancy_system_only ON "organization_user_retention_policies";
CREATE POLICY organization_tenancy_lifecycle ON "organization_user_retention_policies"
  USING (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      = 'managed_human_provisioning'
  )
  WITH CHECK (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      = 'managed_human_provisioning'
  );

DROP POLICY IF EXISTS organization_tenancy_system_only ON "organization_user_resource_authorities";
CREATE POLICY organization_tenancy_lifecycle ON "organization_user_resource_authorities"
  USING (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      = 'managed_human_provisioning'
  )
  WITH CHECK (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      = 'managed_human_provisioning'
  );

DROP POLICY IF EXISTS organization_tenancy_system_only ON "organization_user_resource_grants";
CREATE POLICY organization_tenancy_lifecycle ON "organization_user_resource_grants"
  USING (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      = 'managed_human_provisioning'
  )
  WITH CHECK (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      = 'managed_human_provisioning'
  );

DO $organization_tenancy_managed_human_provisioning$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.ensure_managed_human_personal_workspace(
      p_account_id uuid,
      p_subject_id text,
      p_personal_workspace_id uuid
    )
    RETURNS TABLE (
      organization_membership_id uuid,
      personal_workspace_id uuid
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      expected_external_id text;
      membership_row organization_memberships%%ROWTYPE;
      workspace_row workspaces%%ROWTYPE;
      previous_workspace_id text := pg_catalog.current_setting(
        'opengeni.workspace_id',
        true
      );
      previous_lifecycle_marker text := pg_catalog.current_setting(
        'opengeni.organization_tenancy_lifecycle',
        true
      );
    BEGIN
      IF p_account_id IS NULL
        OR p_subject_id IS NULL
        OR p_personal_workspace_id IS NULL
      THEN
        RAISE EXCEPTION 'managed-human provisioning requires complete identity'
          USING ERRCODE = '42501';
      END IF;

      IF p_subject_id <> pg_catalog.btrim(p_subject_id)
        OR pg_catalog.length(p_subject_id) NOT BETWEEN 1 AND 1024
        OR p_subject_id NOT LIKE 'user:%%'
      THEN
        RAISE EXCEPTION 'managed-human provisioning subject is invalid'
          USING ERRCODE = '42501';
      END IF;

      expected_external_id := pg_catalog.substr(p_subject_id, 6);
      IF expected_external_id IS NULL OR pg_catalog.length(expected_external_id) < 1 THEN
        RAISE EXCEPTION 'managed-human provisioning subject is invalid'
          USING ERRCODE = '42501';
      END IF;

      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
        RAISE EXCEPTION 'managed-human provisioning account authority is invalid'
          USING ERRCODE = '42501';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM managed_accounts account_row
        WHERE account_row.id = p_account_id
          AND account_row.external_source = 'better-auth:user'
          AND account_row.external_id = expected_external_id
      ) THEN
        RAISE EXCEPTION 'managed-human provisioning account identity is invalid'
          USING ERRCODE = '42501';
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM workspace_memberships owner_membership
        INNER JOIN workspaces owner_workspace
          ON owner_workspace.id = owner_membership.workspace_id
         AND owner_workspace.account_id = owner_membership.account_id
        WHERE owner_membership.account_id = p_account_id
          AND owner_membership.subject_id = p_subject_id
          AND owner_membership.role = 'owner'
      ) THEN
        RAISE EXCEPTION 'managed-human provisioning owner membership is invalid'
          USING ERRCODE = '42501';
      END IF;

      SELECT *
      INTO workspace_row
      FROM workspaces candidate_workspace
      WHERE candidate_workspace.id = p_personal_workspace_id
      FOR UPDATE;
      IF NOT FOUND
        OR workspace_row.account_id IS DISTINCT FROM p_account_id
        OR workspace_row.external_source IS DISTINCT FROM 'opengeni:organization-membership'
        OR workspace_row.external_id IS DISTINCT FROM (
          p_account_id::text || ':' || p_subject_id
        )
      THEN
        RAISE EXCEPTION 'managed-human provisioning personal workspace identity is invalid'
          USING ERRCODE = '42501';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM workspaces conflicting_workspace
        WHERE conflicting_workspace.external_source = 'opengeni:organization-membership'
          AND conflicting_workspace.external_id = (
            p_account_id::text || ':' || p_subject_id
          )
          AND conflicting_workspace.id <> p_personal_workspace_id
      ) THEN
        RAISE EXCEPTION 'managed-human provisioning personal workspace identity conflicts'
          USING ERRCODE = '23505';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM workspace_memberships personal_access
        WHERE personal_access.workspace_id = p_personal_workspace_id
      ) THEN
        RAISE EXCEPTION 'managed-human personal workspace already has runtime access'
          USING ERRCODE = '42501';
      END IF;

      -- workspace_inference_controls is FORCE-RLS and needs the exact workspace
      -- context for this structural validation. Restore the caller context on
      -- both success and error before returning from this capability.
      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id',
        p_personal_workspace_id::text,
        true
      );
      IF NOT EXISTS (
        SELECT 1
        FROM workspace_inference_controls control_row
        WHERE control_row.workspace_id = p_personal_workspace_id
          AND control_row.account_id = p_account_id
      ) THEN
        RAISE EXCEPTION 'managed-human personal workspace control is missing'
          USING ERRCODE = '42501';
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        'managed_human_provisioning',
        true
      );

      INSERT INTO organization_memberships (
        account_id,
        subject_id,
        status,
        personal_workspace_id
      ) VALUES (
        p_account_id,
        p_subject_id,
        'active',
        p_personal_workspace_id
      )
      ON CONFLICT (account_id, subject_id) DO NOTHING;

      SELECT *
      INTO membership_row
      FROM organization_memberships candidate_membership
      WHERE candidate_membership.account_id = p_account_id
        AND candidate_membership.subject_id = p_subject_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'managed-human organization membership was not created'
          USING ERRCODE = 'P0002';
      END IF;

      IF membership_row.status IN ('suspended', 'revoked') THEN
        RAISE EXCEPTION 'managed-human organization membership is not active'
          USING ERRCODE = '42501';
      END IF;
      IF membership_row.status = 'active'
        AND membership_row.personal_workspace_id IS DISTINCT FROM p_personal_workspace_id
      THEN
        RAISE EXCEPTION 'managed-human organization membership personal workspace conflicts'
          USING ERRCODE = '23505';
      END IF;
      IF membership_row.status = 'provisioning'
        AND membership_row.personal_workspace_id IS NOT NULL
        AND membership_row.personal_workspace_id IS DISTINCT FROM p_personal_workspace_id
      THEN
        RAISE EXCEPTION 'managed-human organization membership personal workspace conflicts'
          USING ERRCODE = '23505';
      END IF;

      IF membership_row.status = 'provisioning' THEN
        UPDATE organization_memberships
        SET status = 'active',
            personal_workspace_id = p_personal_workspace_id,
            updated_at = pg_catalog.clock_timestamp()
        WHERE id = membership_row.id;
        membership_row.status := 'active';
        membership_row.personal_workspace_id := p_personal_workspace_id;
      END IF;

      IF membership_row.status <> 'active'
        OR membership_row.personal_workspace_id IS DISTINCT FROM p_personal_workspace_id
      THEN
        RAISE EXCEPTION 'managed-human organization membership did not converge'
          USING ERRCODE = '42501';
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id',
        CASE
          WHEN previous_workspace_id IS NULL THEN ''
          ELSE previous_workspace_id
        END,
        true
      );
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE
          WHEN previous_lifecycle_marker IS NULL THEN ''
          ELSE previous_lifecycle_marker
        END,
        true
      );

      organization_membership_id := membership_row.id;
      personal_workspace_id := membership_row.personal_workspace_id;
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id',
        CASE
          WHEN previous_workspace_id IS NULL THEN ''
          ELSE previous_workspace_id
        END,
        true
      );
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE
          WHEN previous_lifecycle_marker IS NULL THEN ''
          ELSE previous_lifecycle_marker
        END,
        true
      );
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.ensure_managed_human_personal_workspace(uuid,text,uuid) FROM PUBLIC',
    data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.ensure_managed_human_personal_workspace(uuid,text,uuid) TO opengeni_app',
      data_schema
    );
  END IF;
END
$organization_tenancy_managed_human_provisioning$;

COMMENT ON FUNCTION ensure_managed_human_personal_workspace(uuid, text, uuid) IS
  'Lifecycle-only managed-human organization membership and personal-workspace provisioning; no workspace access grant.';
