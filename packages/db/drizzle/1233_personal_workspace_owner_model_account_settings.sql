-- deployment-mode: rolling
-- The owner of a Personal workspace may change its model account settings
-- that the organization has not locked (rotation, primary, fallback order,
-- switching models, personal subscriptions, a provider's source), exactly as
-- a shared workspace's administrators can (docs/organization-tenancy.md).
-- Locked settings still win: WITH CHECK still requires an empty lock list on a
-- workspace row, and the lock guard and resolver are unchanged.
--
-- subscription_settings_manager gains a third arm for a row of the context
-- organization and workspace when all of these hold:
-- - the workspace carries the Personal identity of the context subject
--   (organization id ':' subject);
-- - that subject has its owner row there (1231; 1159 allows no other row);
-- - the transaction declared opengeni.personal_workspace_owner_settings as
--   that same subject. The API declares it only after it verified the owner
--   acting as themselves (workspaceSettingsAuthorized), never for a delegated
--   bearer, agent or API key that merely names the owner's subject (a delegated
--   token whose verified ceiling includes workspace:admin counts as the owner,
--   as on the owner's other Personal settings).
--
-- The organization administrator arm no longer reaches another person's
-- Personal workspace row from inside a workspace context. With no workspace
-- context (the organization's own routes, and the lock-change trigger that
-- clears workspace overrides) it still reaches every row of the organization,
-- so a new lock still replaces Personal workspaces' changes. An organization
-- administrator's own Personal workspace is unchanged.
--
-- Shared workspace rows, and every Personal row without the declaration, are
-- decided exactly as before. Rolling: the previous release never declares the
-- setting, so for it the new arm is inert, and no route of it writes another
-- person's Personal row. No function is added or changed.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER POLICY subscription_settings_manager ON subscription_settings
  USING (
    (
      (account_id)::text = NULLIF(current_setting('opengeni.account_id', true), '')
      AND COALESCE((
        SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid)
        FROM (SELECT NULLIF(current_setting('opengeni.account_id', true), '') AS account_setting) admin_scope
        WHERE admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ), false)
      AND (
        NULLIF(current_setting('opengeni.workspace_id', true), '') IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM workspaces other_personal
          WHERE other_personal.id = subscription_settings.workspace_id
            AND other_personal.external_source = 'opengeni:organization-membership'
            AND other_personal.external_id IS DISTINCT FROM
              subscription_settings.account_id::text || ':' || NULLIF(current_setting('opengeni.subject_id', true), '')
        )
      )
    )
    OR (
      workspace_id = (NULLIF(current_setting('opengeni.workspace_id', true), ''))::uuid
      AND EXISTS (
        SELECT 1 FROM workspace_memberships grant_row
        WHERE grant_row.account_id = subscription_settings.account_id
          AND grant_row.workspace_id = subscription_settings.workspace_id
          AND grant_row.subject_id = NULLIF(current_setting('opengeni.subject_id', true), '')
          AND opengeni_private.workspace_membership_administers(grant_row.role, grant_row.permissions)
      )
    )
    OR (
      workspace_id = (NULLIF(current_setting('opengeni.workspace_id', true), ''))::uuid
      AND (account_id)::text = NULLIF(current_setting('opengeni.account_id', true), '')
      AND EXISTS (
        SELECT 1 FROM workspaces personal
        JOIN workspace_memberships owner_row
          ON owner_row.workspace_id = personal.id AND owner_row.account_id = personal.account_id
        WHERE personal.id = subscription_settings.workspace_id
          AND personal.account_id = subscription_settings.account_id
          AND personal.external_source = 'opengeni:organization-membership'
          AND personal.external_id = personal.account_id::text || ':' || owner_row.subject_id
          AND owner_row.subject_id = NULLIF(current_setting('opengeni.subject_id', true), '')
          AND owner_row.subject_id = NULLIF(current_setting('opengeni.personal_workspace_owner_settings', true), '')
      )
    )
  )
  WITH CHECK (
    (
      (account_id)::text = NULLIF(current_setting('opengeni.account_id', true), '')
      AND COALESCE((
        SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid)
        FROM (SELECT NULLIF(current_setting('opengeni.account_id', true), '') AS account_setting) admin_scope
        WHERE admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ), false)
      AND (
        NULLIF(current_setting('opengeni.workspace_id', true), '') IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM workspaces other_personal
          WHERE other_personal.id = subscription_settings.workspace_id
            AND other_personal.external_source = 'opengeni:organization-membership'
            AND other_personal.external_id IS DISTINCT FROM
              subscription_settings.account_id::text || ':' || NULLIF(current_setting('opengeni.subject_id', true), '')
        )
      )
    )
    OR (
      workspace_id = (NULLIF(current_setting('opengeni.workspace_id', true), ''))::uuid
      AND cardinality(locked_settings) = 0
      AND EXISTS (
        SELECT 1 FROM workspace_memberships grant_row
        WHERE grant_row.account_id = subscription_settings.account_id
          AND grant_row.workspace_id = subscription_settings.workspace_id
          AND grant_row.subject_id = NULLIF(current_setting('opengeni.subject_id', true), '')
          AND opengeni_private.workspace_membership_administers(grant_row.role, grant_row.permissions)
      )
    )
    OR (
      workspace_id = (NULLIF(current_setting('opengeni.workspace_id', true), ''))::uuid
      AND (account_id)::text = NULLIF(current_setting('opengeni.account_id', true), '')
      AND cardinality(locked_settings) = 0
      AND EXISTS (
        SELECT 1 FROM workspaces personal
        JOIN workspace_memberships owner_row
          ON owner_row.workspace_id = personal.id AND owner_row.account_id = personal.account_id
        WHERE personal.id = subscription_settings.workspace_id
          AND personal.account_id = subscription_settings.account_id
          AND personal.external_source = 'opengeni:organization-membership'
          AND personal.external_id = personal.account_id::text || ':' || owner_row.subject_id
          AND owner_row.subject_id = NULLIF(current_setting('opengeni.subject_id', true), '')
          AND owner_row.subject_id = NULLIF(current_setting('opengeni.personal_workspace_owner_settings', true), '')
      )
    )
  );
