-- deployment-mode: rolling
-- Newly authored initial/direct Rig versions stay inactive until the worker
-- publishes an exact native platform-surface validation receipt.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE rig_versions
  ADD COLUMN verification jsonb NOT NULL DEFAULT '{"status":"unverified"}'::jsonb;

CREATE OR REPLACE FUNCTION create_scoped_rig(
  p_account_id uuid,
  p_workspace_id uuid,
  p_scope text,
  p_name text,
  p_description text,
  p_created_by text,
  p_initial_version jsonb,
  p_allow_organization boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  owner_membership organization_memberships%ROWTYPE;
  caller_subject text := nullif(pg_catalog.current_setting('opengeni.subject_id', true), '');
  rig_id uuid := pg_catalog.gen_random_uuid();
  authority_id uuid;
  result jsonb;
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'write')
  ON CONFLICT DO NOTHING;
  IF p_account_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.workspace_id', true), '')::uuid
    OR p_scope NOT IN ('organization', 'workspace', 'user')
  THEN RAISE EXCEPTION 'invalid scoped rig creation request' USING ERRCODE = '42501';
  END IF;
  IF p_scope = 'organization' AND NOT p_allow_organization THEN
    RAISE EXCEPTION 'organization rig creation requires account authority'
      USING ERRCODE = '42501';
  ELSIF p_scope = 'user' THEN
    SELECT membership.* INTO STRICT owner_membership
    FROM organization_memberships membership
    WHERE membership.account_id = p_account_id AND membership.subject_id = caller_subject
      AND membership.status = 'active' AND membership.revoked_at IS NULL FOR SHARE;
    IF owner_membership.personal_workspace_id IS DISTINCT FROM p_workspace_id THEN
      PERFORM 1 FROM workspace_memberships workspace_membership
      WHERE workspace_membership.account_id = p_account_id
        AND workspace_membership.workspace_id = p_workspace_id
        AND workspace_membership.subject_id = caller_subject FOR KEY SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'rig owner lacks workspace access'
        USING ERRCODE = '42501'; END IF;
    END IF;
    authority_id := pg_catalog.gen_random_uuid();
    INSERT INTO organization_user_resource_authorities(
      id, account_id, organization_membership_id, resource_kind, resource_id,
      origin_workspace_id, generation, status
    ) VALUES (authority_id, p_account_id, owner_membership.id, 'rig', rig_id,
      p_workspace_id, 1, 'active');
  END IF;
  INSERT INTO rigs(
    id, account_id, workspace_id, name, description, created_by, authority_scope,
    authority_id, owner_organization_membership_id, origin_workspace_id,
    generation, status
  ) VALUES (
    rig_id, p_account_id, p_workspace_id, p_name, p_description, p_created_by, p_scope,
    authority_id, CASE WHEN p_scope = 'user' THEN owner_membership.id ELSE NULL END,
    p_workspace_id, 1, 'active'
  );
  INSERT INTO rig_versions(
    account_id, workspace_id, rig_id, version, image, setup_script, checks,
    credential_hooks, default_variable_set_ids, changelog, provider_images,
    verification, created_by, active
  ) VALUES (
    p_account_id, p_workspace_id, rig_id, 1, p_initial_version ->> 'image',
    p_initial_version ->> 'setupScript', coalesce(p_initial_version -> 'checks', '[]'::jsonb),
    coalesce(p_initial_version -> 'credentialHooks', '[]'::jsonb),
    coalesce(p_initial_version -> 'defaultVariableSetIds', '[]'::jsonb),
    p_initial_version ->> 'changelog', '{}'::jsonb,
    coalesce(p_initial_version -> 'verification', '{"status":"unverified"}'::jsonb),
    coalesce(p_initial_version ->> 'createdBy', p_created_by),
    coalesce((p_initial_version ->> 'active')::boolean, true)
  );
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'write';
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'read')
  ON CONFLICT DO NOTHING;
  result := scoped_rig_json(rig_id);
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'read';
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION create_scoped_rig(
  uuid, uuid, text, text, text, text, jsonb, boolean
) FROM PUBLIC;