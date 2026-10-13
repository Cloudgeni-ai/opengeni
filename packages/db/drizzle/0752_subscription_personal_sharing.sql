-- deployment-mode: rolling
-- Explicit personal-to-shared conversion. This is not an organization-wide
-- personal-account inventory: only the exact owner who is also an organization
-- administrator can inspect or convert the named account. The access editor
-- applies the requested shared reach in the same transaction after conversion.
SET LOCAL lock_timeout = '5s';

DO $install$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_core_personal_sharing(
      p_provider text, p_account_id uuid, p_subject_id text, p_connection_id uuid,
      p_expected_version integer DEFAULT NULL
    ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      target subscription_connections%%ROWTYPE;
      result jsonb;
    BEGIN
      IF p_connection_id IS NULL
        OR NOT opengeni_subscription_internal.subscription_core_writer_context(
          p_provider, p_account_id, NULL, p_subject_id)
      THEN RETURN NULL; END IF;
      -- Offboarding and role changes take this fence exclusively. Take it
      -- before capabilities, identity locks or connection rows.
      PERFORM pg_advisory_xact_lock_shared(hashtextextended(
        'organization-membership:' || p_account_id::text, 0));
      IF NOT opengeni_private.subscription_organization_admin(p_account_id)
      THEN RETURN NULL; END IF;
      PERFORM opengeni_subscription_internal.grant_subscription_core_owner_capability(
        p_provider, 'connection_owner', p_account_id, NULL, p_subject_id, p_connection_id);
      SELECT connection.* INTO target FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.provider = p_provider
        AND connection.kind = opengeni_private.subscription_core_connection_kind(p_provider)
        AND connection.ownership = 'personal' AND connection.owner_subject_id = p_subject_id
        AND connection.disconnected_at IS NULL
        AND EXISTS (SELECT 1 FROM organization_user_resource_authorities resource
          WHERE resource.account_id = connection.account_id AND resource.id = connection.authority_id
            AND resource.resource_id = connection.id AND resource.resource_kind = 'subscription_connection'
            AND resource.organization_membership_id = connection.owner_organization_membership_id
            AND resource.generation = connection.authority_generation
            AND resource.status = 'active' AND resource.revoked_at IS NULL);
      IF NOT FOUND THEN
        PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(p_provider, p_account_id);
        RETURN NULL;
      END IF;
      IF p_expected_version IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(
          'subscription-personal-authority:' || p_account_id::text || ':' ||
            target.owner_organization_membership_id::text, 0));
        -- The ordinary shared reconnect/create writer owns the same key.
        PERFORM pg_advisory_xact_lock(hashtextextended(
          'subscription-connect:' || p_account_id::text || ':' || p_provider || ':shared:' ||
            coalesce(target.provider_account_id, ''), 0));
        PERFORM pg_advisory_xact_lock(hashtextextended(
          'subscription-refresh:' || p_connection_id::text, 0));
        SELECT connection.* INTO target FROM subscription_connections connection
        WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
          AND connection.provider = p_provider
          AND connection.kind = opengeni_private.subscription_core_connection_kind(p_provider)
          AND connection.ownership = 'personal' AND connection.owner_subject_id = p_subject_id
          AND connection.disconnected_at IS NULL
          AND EXISTS (SELECT 1 FROM organization_user_resource_authorities resource
            WHERE resource.account_id = connection.account_id AND resource.id = connection.authority_id
              AND resource.resource_id = connection.id AND resource.resource_kind = 'subscription_connection'
              AND resource.organization_membership_id = connection.owner_organization_membership_id
              AND resource.generation = connection.authority_generation
              AND resource.status = 'active' AND resource.revoked_at IS NULL)
          FOR UPDATE;
        IF NOT FOUND OR target.access_version <> p_expected_version THEN
          PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(p_provider, p_account_id);
          RETURN NULL;
        END IF;
        IF target.provider_account_id IS NULL OR target.provider_subject_id IS NULL
          OR target.provider_subject_id LIKE 'legacy:%%' THEN
          RAISE EXCEPTION 'sign in again before sharing this account' USING ERRCODE = '22023';
        END IF;
        IF EXISTS (SELECT 1 FROM subscription_connections connection
          WHERE connection.account_id = p_account_id AND connection.provider = p_provider
            AND connection.kind = opengeni_private.subscription_core_connection_kind(p_provider)
            AND connection.ownership = 'shared'
            AND connection.provider_account_id = target.provider_account_id
            AND connection.provider_subject_id = target.provider_subject_id) THEN
          RAISE EXCEPTION 'this provider account is already shared' USING ERRCODE = '22023';
        END IF;
        -- Revoke only this resource, before clearing its owner fields. Frozen
        -- personal receipts remain historical facts, not new shared authority.
        UPDATE organization_user_resource_authorities resource
        SET status = 'revoked', revoked_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE resource.account_id = p_account_id AND resource.id = target.authority_id
          AND resource.resource_id = target.id AND resource.status <> 'revoked';
        UPDATE subscription_connections connection SET
          ownership = 'shared', owner_organization_membership_id = NULL,
          owner_subject_id = NULL, authority_id = NULL, authority_resource_kind = NULL,
          authority_generation = NULL, scope_kind = 'workspaces',
          allow_personal_workspaces = false, managed_by_workspace_id = NULL,
          version = version + 1, updated_at = clock_timestamp()
        WHERE connection.account_id = p_account_id AND connection.id = target.id;
        DELETE FROM subscription_connection_assignment_policies
        WHERE account_id = p_account_id AND connection_id = target.id;
        DELETE FROM subscription_connection_workspaces
        WHERE account_id = p_account_id AND connection_id = target.id;
        DELETE FROM subscription_connection_people
        WHERE account_id = p_account_id AND connection_id = target.id;
        -- No implicit assignments, credential rewrites, lease/pin changes or
        -- history edits. The existing editor writes reach and advances the
        -- access version once, atomically with this conversion.
      END IF;
      result := jsonb_build_object('id', target.id, 'allowedModels', target.allowed_model_ids,
        'version', target.access_version);
      PERFORM opengeni_subscription_internal.drop_subscription_core_owner_capabilities(p_provider, p_account_id);
      RETURN result;
    END
    $body$
  $ddl$, data_schema);
END
$install$;

REVOKE ALL ON FUNCTION opengeni_private.subscription_core_personal_sharing(text,uuid,text,uuid,integer) FROM PUBLIC;
DO $grants$
DECLARE application_role text;
BEGIN
  FOR application_role IN
    SELECT role_value.rolname
    FROM jsonb_array_elements_text(coalesce(nullif(current_setting(
      'opengeni.migration_application_roles', true), ''), '[]')::jsonb) configured(value)
    JOIN pg_roles role_value ON role_value.rolname = configured.value
    UNION SELECT 'opengeni_app' WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.subscription_core_personal_sharing(text,uuid,text,uuid,integer) TO %I', application_role);
  END LOOP;
END
$grants$;
