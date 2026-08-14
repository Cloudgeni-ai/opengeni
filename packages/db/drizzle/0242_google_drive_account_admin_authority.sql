-- deployment-mode: rolling
-- Expose one exact read-only SECURITY DEFINER check for Google Drive OAuth
-- callbacks. The runtime role retains no direct organization-membership table
-- access; the routine crosses FORCE RLS only under the existing transaction-
-- local managed-human lifecycle marker and restores that marker before return.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $google_drive_account_admin_authority$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.google_drive_workspace_account_admin_authorized(
      p_account_id uuid,
      p_workspace_id uuid,
      p_subject_id text
    )
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      account_source text;
      account_external_id text;
      membership_id uuid;
      authorized boolean := false;
      previous_marker text := pg_catalog.current_setting(
        'opengeni.organization_tenancy_lifecycle', true
      );
    BEGIN
      SELECT account.external_source, account.external_id
      INTO account_source, account_external_id
      FROM managed_accounts account
      INNER JOIN workspaces workspace
        ON workspace.account_id = account.id
      WHERE account.id = p_account_id
        AND workspace.id = p_workspace_id
      FOR SHARE OF account, workspace;

      IF account_source IN ('opengeni:local', 'opengeni:configured') THEN
        RETURN true;
      END IF;
      IF account_source IS DISTINCT FROM 'better-auth:user'
        OR p_subject_id IS DISTINCT FROM 'user:' || account_external_id THEN
        RETURN false;
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        'managed_human_provisioning',
        true
      );
      SELECT membership.id
      INTO membership_id
      FROM organization_memberships membership
      WHERE membership.account_id = p_account_id
        AND membership.subject_id = p_subject_id
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
      LIMIT 1
      FOR SHARE OF membership;
      authorized := membership_id IS NOT NULL;
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END,
        true
      );
      RETURN authorized;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END,
        true
      );
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.google_drive_workspace_account_admin_authorized(uuid, uuid, text) FROM PUBLIC',
    data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.google_drive_workspace_account_admin_authorized(uuid, uuid, text) TO opengeni_app',
      data_schema
    );
  END IF;
END
$google_drive_account_admin_authority$;
