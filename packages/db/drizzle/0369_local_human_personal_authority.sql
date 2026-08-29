-- deployment-mode: rolling
-- Give the explicit single-user local identity the same private authority
-- anchor as a managed human. This does not add runtime access to the hidden
-- personal workspace and does not authorize configured keys or host services.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $local_human_personal_authority$
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
      managed_identity boolean := false;
      local_identity boolean := false;
      membership_row organization_memberships%%ROWTYPE;
      workspace_row workspaces%%ROWTYPE;
      previous_workspace_id text := pg_catalog.current_setting(
        'opengeni.workspace_id', true
      );
      previous_lifecycle_marker text := pg_catalog.current_setting(
        'opengeni.organization_tenancy_lifecycle', true
      );
    BEGIN
      IF p_account_id IS NULL
        OR p_subject_id IS NULL
        OR p_personal_workspace_id IS NULL
        OR p_subject_id <> pg_catalog.btrim(p_subject_id)
        OR pg_catalog.length(p_subject_id) NOT BETWEEN 1 AND 1024
      THEN
        RAISE EXCEPTION 'human provisioning requires a valid complete identity'
          USING ERRCODE = '42501';
      END IF;

      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
        RAISE EXCEPTION 'human provisioning account authority is invalid'
          USING ERRCODE = '42501';
      END IF;

      IF p_subject_id LIKE 'user:%%' THEN
        expected_external_id := pg_catalog.substr(p_subject_id, 6);
        SELECT EXISTS (
          SELECT 1
          FROM managed_accounts account_row
          WHERE account_row.id = p_account_id
            AND account_row.external_source = 'better-auth:user'
            AND account_row.external_id = expected_external_id
        ) INTO managed_identity;
      END IF;
      SELECT EXISTS (
        SELECT 1
        FROM managed_accounts account_row
        WHERE account_row.id = p_account_id
          AND account_row.external_source = 'opengeni:local'
          AND account_row.external_id = 'default'
          AND p_subject_id = 'dev'
          AND opengeni_private.current_subject_id() = p_subject_id
      ) INTO local_identity;
      IF NOT managed_identity AND NOT local_identity THEN
        RAISE EXCEPTION 'human provisioning account identity is invalid'
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
          AND (
            NOT local_identity
            OR (
              owner_workspace.external_source = 'opengeni:local'
              AND owner_workspace.external_id = 'default'
            )
          )
      ) THEN
        RAISE EXCEPTION 'human provisioning owner membership is invalid'
          USING ERRCODE = '42501';
      END IF;

      SELECT * INTO workspace_row
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
        RAISE EXCEPTION 'human provisioning personal workspace identity is invalid'
          USING ERRCODE = '42501';
      END IF;

      IF EXISTS (
        SELECT 1 FROM workspaces conflicting_workspace
        WHERE conflicting_workspace.external_source = 'opengeni:organization-membership'
          AND conflicting_workspace.external_id = p_account_id::text || ':' || p_subject_id
          AND conflicting_workspace.id <> p_personal_workspace_id
      ) THEN
        RAISE EXCEPTION 'human provisioning personal workspace identity conflicts'
          USING ERRCODE = '23505';
      END IF;

      IF EXISTS (
        SELECT 1 FROM workspace_memberships personal_access
        WHERE personal_access.workspace_id = p_personal_workspace_id
      ) THEN
        RAISE EXCEPTION 'human personal workspace already has runtime access'
          USING ERRCODE = '42501';
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id', p_personal_workspace_id::text, true
      );
      IF NOT EXISTS (
        SELECT 1 FROM workspace_inference_controls control_row
        WHERE control_row.workspace_id = p_personal_workspace_id
          AND control_row.account_id = p_account_id
      ) THEN
        RAISE EXCEPTION 'human personal workspace control is missing'
          USING ERRCODE = '42501';
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        'managed_human_provisioning',
        true
      );
      INSERT INTO organization_memberships (
        account_id, subject_id, status, personal_workspace_id
      ) VALUES (
        p_account_id, p_subject_id, 'active', p_personal_workspace_id
      ) ON CONFLICT (account_id, subject_id) DO NOTHING;

      SELECT * INTO membership_row
      FROM organization_memberships candidate_membership
      WHERE candidate_membership.account_id = p_account_id
        AND candidate_membership.subject_id = p_subject_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'human organization membership was not created'
          USING ERRCODE = 'P0002';
      END IF;
      IF membership_row.status IN ('suspended', 'revoked') THEN
        RAISE EXCEPTION 'human organization membership is not active'
          USING ERRCODE = '42501';
      END IF;
      IF membership_row.personal_workspace_id IS NOT NULL
        AND membership_row.personal_workspace_id IS DISTINCT FROM p_personal_workspace_id
      THEN
        RAISE EXCEPTION 'human organization membership personal workspace conflicts'
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
        RAISE EXCEPTION 'human organization membership did not converge'
          USING ERRCODE = '42501';
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id', coalesce(previous_workspace_id, ''), true
      );
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        coalesce(previous_lifecycle_marker, ''),
        true
      );
      organization_membership_id := membership_row.id;
      personal_workspace_id := membership_row.personal_workspace_id;
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id', coalesce(previous_workspace_id, ''), true
      );
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        coalesce(previous_lifecycle_marker, ''),
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
$local_human_personal_authority$;

COMMENT ON FUNCTION ensure_managed_human_personal_workspace(uuid, text, uuid) IS
  'Lifecycle-only managed or explicit local-human organization membership and personal-workspace provisioning; no workspace access grant.';

CREATE FUNCTION issue_self_local_connection_use_grant(
  p_account_id uuid,
  p_authority_id uuid,
  p_workspace_id uuid,
  p_context text,
  p_workspace_shared_acknowledged boolean DEFAULT false
) RETURNS TABLE (
  grant_id uuid, organization_id uuid, authority_generation bigint,
  target_workspace_id uuid, target_session_id uuid, action text,
  grant_mode text, grant_context text, authority_epoch integer,
  grant_generation bigint, grant_status text, expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
#variable_conflict use_column
DECLARE
  caller_subject text := nullif(current_setting('opengeni.subject_id', true), '');
  owner_membership_id uuid;
BEGIN
  PERFORM set_config(
    'opengeni.organization_tenancy_lifecycle', 'personal_resource_grant_management', true
  );
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR caller_subject IS DISTINCT FROM 'dev'
    OR p_context NOT IN ('user_private', 'workspace_shared')
    OR (p_context = 'workspace_shared' AND p_workspace_shared_acknowledged IS NOT TRUE)
    OR NOT EXISTS (
      SELECT 1 FROM managed_accounts account_row
      WHERE account_row.id = p_account_id
        AND account_row.external_source = 'opengeni:local'
        AND account_row.external_id = 'default'
    )
  THEN
    RAISE EXCEPTION 'local connection grant authority is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT membership.id INTO owner_membership_id
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = caller_subject
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM workspace_memberships workspace_membership
    WHERE workspace_membership.account_id = p_account_id
      AND workspace_membership.workspace_id = p_workspace_id
      AND workspace_membership.subject_id = caller_subject
      AND workspace_membership.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'local connection grant owner is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT authority.generation INTO authority_generation
  FROM organization_user_resource_authorities authority
  WHERE authority.id = p_authority_id
    AND authority.account_id = p_account_id
    AND authority.organization_membership_id = owner_membership_id
    AND authority.resource_kind = 'connection'
    AND authority.status = 'active'
    AND authority.revoked_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'local connection authority is unavailable'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO organization_user_resource_grants (
    account_id, authority_id, owner_organization_membership_id, workspace_id,
    session_id, action, mode, context, authority_epoch, generation, status
  ) VALUES (
    p_account_id, p_authority_id, owner_membership_id, p_workspace_id,
    NULL, 'connection.use', 'always', p_context, NULL, 1, 'active'
  )
  ON CONFLICT (account_id, authority_id, workspace_id, action, mode, context,
    (coalesce(session_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    (coalesce(authority_epoch, 0))) WHERE status = 'active'
  DO UPDATE SET updated_at = organization_user_resource_grants.updated_at
  RETURNING id, workspace_id, session_id, organization_user_resource_grants.action,
    mode, context, organization_user_resource_grants.authority_epoch, generation,
    status, organization_user_resource_grants.expires_at
  INTO grant_id, target_workspace_id, target_session_id, action, grant_mode,
    grant_context, authority_epoch, grant_generation, grant_status, expires_at;
  organization_id := p_account_id;
  RETURN NEXT;
END
$body$;

DO $local_connection_grant_search_path$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.issue_self_local_connection_use_grant(uuid,uuid,uuid,text,boolean) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
END
$local_connection_grant_search_path$;
REVOKE ALL ON FUNCTION issue_self_local_connection_use_grant(
  uuid, uuid, uuid, text, boolean
) FROM PUBLIC;
DO $local_connection_grant_role$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION issue_self_local_connection_use_grant(
      uuid, uuid, uuid, text, boolean
    ) TO opengeni_app;
  END IF;
END
$local_connection_grant_role$;

COMMENT ON FUNCTION issue_self_local_connection_use_grant(
  uuid, uuid, uuid, text, boolean
) IS 'Idempotently issues standing connection.use only for the explicit local dev human and exact local owner workspace.';
