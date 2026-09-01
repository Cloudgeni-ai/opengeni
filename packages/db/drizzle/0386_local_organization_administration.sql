-- deployment-mode: maintenance
--
-- The canonical single-user local bootstrap already grants `dev` account-owner
-- authority in the application, but its durable organization membership was
-- left at the default member role. Converge that exact built-in identity and
-- admit it to organization Codex administration without broadening configured,
-- delegated, API-key, service, or agent principals.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE OR REPLACE FUNCTION opengeni_private.assign_managed_self_organization_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
BEGIN
  IF EXISTS (
    SELECT 1 FROM managed_accounts account
    WHERE account.id = NEW.account_id
      AND (
        (
          account.external_source = 'better-auth:user'
          AND NEW.subject_id = 'user:' || account.external_id
        ) OR (
          account.external_source = 'opengeni:local'
          AND account.external_id = 'default'
          AND NEW.subject_id = 'dev'
        )
      )
  ) THEN
    NEW.role := 'owner';
  END IF;
  RETURN NEW;
END
$body$;

DO $pin_local_owner_trigger$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.assign_managed_self_organization_owner() SET search_path = pg_catalog, %I, pg_temp',
    data_schema
  );
END
$pin_local_owner_trigger$;

ALTER TABLE organization_memberships NO FORCE ROW LEVEL SECURITY;
UPDATE organization_memberships membership
SET role = 'owner',
    authorization_revision = membership.authorization_revision + 1,
    updated_at = clock_timestamp()
FROM managed_accounts account
WHERE account.id = membership.account_id
  AND account.external_source = 'opengeni:local'
  AND account.external_id = 'default'
  AND membership.subject_id = 'dev'
  AND membership.status = 'active'
  AND membership.role <> 'owner';
ALTER TABLE organization_memberships FORCE ROW LEVEL SECURITY;

DO $codex_scope_visibility_schema$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.codex_organization_scope_visible(
      p_account_id uuid
    ) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      workspace_value uuid := opengeni_private.current_workspace_id();
      subject_value text := opengeni_private.current_subject_id();
      visible boolean := false;
      previous_lifecycle text := pg_catalog.current_setting(
        'opengeni.organization_tenancy_lifecycle', true
      );
    BEGIN
      IF p_account_id IS NULL
        OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
      THEN
        RETURN false;
      END IF;
      IF workspace_value IS NOT NULL THEN
        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle',
          'organization_membership_lifecycle', true
        );
        SELECT EXISTS (
          SELECT 1 FROM %1$I.workspaces workspace
          WHERE workspace.account_id = p_account_id AND workspace.id = workspace_value
        ) AND NOT EXISTS (
          SELECT 1 FROM %1$I.organization_memberships membership
          WHERE membership.account_id = p_account_id
            AND membership.personal_workspace_id = workspace_value
        ) INTO visible;
        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
        );
        RETURN coalesce(visible, false);
      END IF;
      IF subject_value IS NULL OR NOT (
        subject_value LIKE 'user:%%'
        OR (
          subject_value = 'dev'
          AND EXISTS (
            SELECT 1 FROM %1$I.managed_accounts account
            WHERE account.id = p_account_id
              AND account.external_source = 'opengeni:local'
              AND account.external_id = 'default'
          )
        )
      ) THEN
        RETURN false;
      END IF;
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        'organization_membership_lifecycle', true
      );
      SELECT EXISTS (
        SELECT 1 FROM %1$I.organization_memberships membership
        WHERE membership.account_id = p_account_id
          AND membership.subject_id = subject_value
          AND membership.status = 'active'
          AND membership.role IN ('owner', 'admin')
      ) INTO visible;
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
      );
      RETURN coalesce(visible, false);
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
      );
      RAISE;
    END
    $function$
  $ddl$, data_schema);
END
$codex_scope_visibility_schema$;

REVOKE ALL ON FUNCTION opengeni_private.assign_managed_self_organization_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.codex_organization_scope_visible(uuid) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.assign_managed_self_organization_owner()
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.codex_organization_scope_visible(uuid)
      TO opengeni_app;
  END IF;
END
$grants$;
