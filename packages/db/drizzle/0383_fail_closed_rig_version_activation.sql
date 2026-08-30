-- deployment-mode: maintenance
-- Newly authored initial/direct Rig versions stay inactive until the worker
-- publishes an exact native platform-surface validation receipt.
-- This is a one-way writer-protocol cutover: stop every API, control worker,
-- and turn worker before applying it, and never restart a pre-0383 image. Old
-- writers create/activate versions without the mandatory receipt state.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $rig_version_writer_drain_before_lock$
DECLARE
  configured_roles_text text := nullif(
    current_setting('opengeni.migration_application_roles', true), ''
  );
  configured_roles jsonb;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION
      '0383 Rig verification activation requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0383 Rig verification activation received a malformed application database role list'
      USING ERRCODE = '55000';
  END;
  IF jsonb_typeof(configured_roles) <> 'array'
    OR jsonb_array_length(configured_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(configured_roles) AS roles(value)
      WHERE jsonb_typeof(value) <> 'string'
        OR btrim(value #>> '{}') = ''
        OR octet_length(value #>> '{}') > 63
    )
    OR (
      SELECT count(*) FROM jsonb_array_elements_text(configured_roles)
    ) <> (
      SELECT count(DISTINCT value)
      FROM jsonb_array_elements_text(configured_roles) AS roles(value)
    )
  THEN
    RAISE EXCEPTION
      '0383 Rig verification activation received an invalid application database role list'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0383 Rig verification activation requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$rig_version_writer_drain_before_lock$;

LOCK TABLE rigs IN ACCESS EXCLUSIVE MODE;
LOCK TABLE rig_versions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE rig_changes IN ACCESS EXCLUSIVE MODE;

DO $rig_version_writer_drain_after_lock$
DECLARE
  configured_roles jsonb := current_setting(
    'opengeni.migration_application_roles', false
  )::jsonb;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0383 Rig verification activation requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$rig_version_writer_drain_after_lock$;

ALTER TABLE rig_versions
  ADD COLUMN verification jsonb NOT NULL DEFAULT '{"status":"unverified"}'::jsonb;

-- Version-1 provider-image proof predates exact Browser/Computer target
-- binding. Remove only that optimization proof so the new runtime falls back
-- to logical-image + setup until it publishes current proof.
ALTER TABLE rig_versions NO FORCE ROW LEVEL SECURITY;
UPDATE rig_versions
SET provider_images = (
  SELECT coalesce(
    jsonb_object_agg(
      image.key,
      CASE
        WHEN image.value -> 'coldBootValidation' ->> 'version' = '1'
          THEN image.value - 'coldBootValidation'
        ELSE image.value
      END
    ),
    '{}'::jsonb
  )
  FROM jsonb_each(rig_versions.provider_images) AS image
)
WHERE EXISTS (
  SELECT 1
  FROM jsonb_each(rig_versions.provider_images) AS image
  WHERE image.value -> 'coldBootValidation' ->> 'version' = '1'
);
ALTER TABLE rig_versions FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION opengeni_private.reject_obsolete_rig_provider_image_proof()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_each(NEW.provider_images) AS image
    WHERE image.value -> 'coldBootValidation' ->> 'version' = '1'
  ) THEN
    RAISE EXCEPTION 'rig provider image cold-boot proof version 1 is obsolete'
      USING ERRCODE = '23514',
        CONSTRAINT = 'rig_versions_provider_image_proof_version_check';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION opengeni_private.reject_obsolete_rig_provider_image_proof()
FROM PUBLIC;

DROP TRIGGER IF EXISTS rig_versions_provider_image_proof_trigger ON rig_versions;
CREATE TRIGGER rig_versions_provider_image_proof_trigger
BEFORE INSERT OR UPDATE OF provider_images ON rig_versions
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.reject_obsolete_rig_provider_image_proof();

-- This trigger keeps the maintenance cutover fail-closed. New application code
-- writes inactive/pending rows, while a stale or direct writer that attempts an
-- active unverified INSERT is rejected in the same transaction. Existing active
-- rows are grandfathered and ordinary updates remain available after cutover.
CREATE OR REPLACE FUNCTION opengeni_private.enforce_rig_version_activation_verification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.active = true AND (TG_OP = 'INSERT' OR OLD.active IS DISTINCT FROM true) THEN
    IF NEW.verification ->> 'status' IS DISTINCT FROM 'passed'
      OR NEW.verification ->> 'attemptId' IS NULL
      OR NEW.verification -> 'receipt' ->> 'version' IS DISTINCT FROM '2'
      OR NEW.verification -> 'receipt' -> 'binding' ->> 'sandboxGroupId'
        IS DISTINCT FROM NEW.id::text
      OR NEW.verification -> 'receipt' -> 'binding' ->> 'rigVersionId'
        IS DISTINCT FROM NEW.id::text
    THEN
      RAISE EXCEPTION 'rig version activation requires an exact passing platform-surface receipt'
        USING ERRCODE = '23514',
          CONSTRAINT = 'rig_versions_active_verification_check';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION opengeni_private.enforce_rig_version_activation_verification()
FROM PUBLIC;

DROP TRIGGER IF EXISTS rig_versions_active_verification_trigger ON rig_versions;
CREATE TRIGGER rig_versions_active_verification_trigger
BEFORE INSERT OR UPDATE OF active ON rig_versions
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.enforce_rig_version_activation_verification();

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
    coalesce((p_initial_version ->> 'active')::boolean, false)
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