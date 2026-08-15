-- deployment-mode: rolling
-- Activate explicit organization, workspace, and organization+user ownership
-- for Connected Machines and Rigs. Existing rows remain workspace-owned.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE rigs
  ADD COLUMN generation bigint NOT NULL DEFAULT 1,
  ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD COLUMN revoked_at timestamptz;
ALTER TABLE rigs DROP CONSTRAINT rigs_authority_scope_check;
ALTER TABLE rigs DROP CONSTRAINT rigs_authority_shape_check;
ALTER TABLE rigs ADD CONSTRAINT rigs_authority_scope_check
  CHECK (authority_scope IN ('organization', 'workspace', 'user')) NOT VALID;
ALTER TABLE rigs ADD CONSTRAINT rigs_authority_shape_check CHECK (
  (authority_scope IN ('organization', 'workspace') AND authority_id IS NULL
    AND owner_organization_membership_id IS NULL)
  OR (authority_scope = 'user' AND authority_id IS NOT NULL
    AND owner_organization_membership_id IS NOT NULL)
) NOT VALID;
ALTER TABLE rigs ADD CONSTRAINT rigs_generation_check CHECK (generation > 0) NOT VALID;
ALTER TABLE rigs ADD CONSTRAINT rigs_status_check
  CHECK (status IN ('active', 'revoked')) NOT VALID;
ALTER TABLE rigs ADD CONSTRAINT rigs_revocation_check CHECK (
  (status = 'active' AND revoked_at IS NULL)
  OR (status = 'revoked' AND revoked_at IS NOT NULL)
) NOT VALID;
ALTER TABLE rigs VALIDATE CONSTRAINT rigs_authority_scope_check;
ALTER TABLE rigs VALIDATE CONSTRAINT rigs_authority_shape_check;
ALTER TABLE rigs VALIDATE CONSTRAINT rigs_generation_check;
ALTER TABLE rigs VALIDATE CONSTRAINT rigs_status_check;
ALTER TABLE rigs VALIDATE CONSTRAINT rigs_revocation_check;
DROP INDEX rigs_workspace_name_idx;
CREATE UNIQUE INDEX rigs_workspace_name_active_idx ON rigs(workspace_id, name)
  WHERE authority_scope = 'workspace' AND status = 'active';
CREATE UNIQUE INDEX rigs_organization_name_active_idx ON rigs(account_id, name)
  WHERE authority_scope = 'organization' AND status = 'active';
CREATE UNIQUE INDEX rigs_user_name_active_idx
  ON rigs(account_id, owner_organization_membership_id, name)
  WHERE authority_scope = 'user' AND status = 'active';

ALTER TABLE enrollments
  ADD COLUMN authority_scope text NOT NULL DEFAULT 'workspace',
  ADD COLUMN authority_id uuid,
  ADD COLUMN owner_organization_membership_id uuid,
  ADD COLUMN origin_workspace_id uuid,
  ADD COLUMN generation bigint NOT NULL DEFAULT 1;
UPDATE enrollments SET origin_workspace_id = workspace_id WHERE origin_workspace_id IS NULL;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_authority_scope_check
  CHECK (authority_scope IN ('organization', 'workspace', 'user')) NOT VALID;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_authority_shape_check CHECK (
  (authority_scope IN ('organization', 'workspace') AND authority_id IS NULL
    AND owner_organization_membership_id IS NULL)
  OR (authority_scope = 'user' AND authority_id IS NOT NULL
    AND owner_organization_membership_id IS NOT NULL)
) NOT VALID;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_generation_check
  CHECK (generation > 0) NOT VALID;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_authority_fk
  FOREIGN KEY (authority_id, account_id, owner_organization_membership_id)
  REFERENCES organization_user_resource_authorities(
    id, account_id, organization_membership_id
  ) ON DELETE RESTRICT NOT VALID;
ALTER TABLE enrollments ADD CONSTRAINT enrollments_origin_workspace_fk
  FOREIGN KEY (origin_workspace_id, account_id)
  REFERENCES workspaces(id, account_id) ON DELETE SET NULL (origin_workspace_id) NOT VALID;
ALTER TABLE enrollments VALIDATE CONSTRAINT enrollments_authority_scope_check;
ALTER TABLE enrollments VALIDATE CONSTRAINT enrollments_authority_shape_check;
ALTER TABLE enrollments VALIDATE CONSTRAINT enrollments_generation_check;
ALTER TABLE enrollments VALIDATE CONSTRAINT enrollments_authority_fk;
ALTER TABLE enrollments VALIDATE CONSTRAINT enrollments_origin_workspace_fk;
DROP INDEX enrollments_workspace_pubkey_idx;
CREATE UNIQUE INDEX enrollments_workspace_pubkey_idx
  ON enrollments(workspace_id, pubkey)
  WHERE authority_scope = 'workspace';
CREATE UNIQUE INDEX enrollments_organization_pubkey_idx
  ON enrollments(account_id, pubkey)
  WHERE authority_scope = 'organization';
CREATE UNIQUE INDEX enrollments_user_pubkey_idx
  ON enrollments(account_id, owner_organization_membership_id, pubkey)
  WHERE authority_scope = 'user';

CREATE TABLE opengeni_private.scoped_compute_capabilities (
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  capability_kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT scoped_compute_capabilities_kind_check
    CHECK (capability_kind IN ('read', 'write', 'runtime')),
  CONSTRAINT scoped_compute_capabilities_pk
    PRIMARY KEY (backend_pid, transaction_id, capability_kind)
);
REVOKE ALL ON TABLE opengeni_private.scoped_compute_capabilities FROM PUBLIC;

CREATE OR REPLACE FUNCTION opengeni_private.scoped_compute_capability_active(
  p_capability_kind text DEFAULT NULL
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM opengeni_private.scoped_compute_capabilities capability
    WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND (p_capability_kind IS NULL OR capability.capability_kind = p_capability_kind)
  )
$$;
REVOKE ALL ON FUNCTION opengeni_private.scoped_compute_capability_active(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION sync_personal_enrollment_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.authority_scope <> 'user' OR (
    NEW.generation = OLD.generation AND NEW.status = OLD.status
  ) THEN
    RETURN NEW;
  END IF;
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'write')
  ON CONFLICT DO NOTHING;
  UPDATE organization_user_resource_authorities
  SET generation = NEW.generation, status = NEW.status,
    revoked_at = CASE WHEN NEW.status = 'revoked' THEN coalesce(NEW.revoked_at, clock_timestamp())
      ELSE NULL END,
    updated_at = clock_timestamp()
  WHERE id = NEW.authority_id AND account_id = NEW.account_id
    AND organization_membership_id = NEW.owner_organization_membership_id
    AND resource_kind = 'connected_machine' AND resource_id = NEW.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'personal machine authority is missing' USING ERRCODE = '42501';
  END IF;
  UPDATE organization_user_resource_grants
  SET status = 'revoked', revoked_at = clock_timestamp(),
    generation = generation + 1, updated_at = clock_timestamp()
  WHERE authority_id = NEW.authority_id AND account_id = NEW.account_id
    AND status = 'active';
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'write';
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$$;
CREATE TRIGGER sync_personal_enrollment_authority_after_update
AFTER UPDATE OF generation, status ON enrollments
FOR EACH ROW EXECUTE FUNCTION sync_personal_enrollment_authority();
REVOKE ALL ON FUNCTION sync_personal_enrollment_authority() FROM PUBLIC;

DO $policies$
DECLARE
  data_schema text := current_schema();
  migration_owner text := current_user;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'rigs', 'rig_versions', 'rig_changes', 'enrollments', 'sandboxes',
    'organization_memberships', 'workspace_memberships',
    'organization_user_resource_authorities', 'organization_user_resource_grants',
    'sessions', 'session_turns', 'session_turn_attempts',
    'session_attempt_interruptions', 'session_attempt_personal_resource_admissions',
    'session_attempt_personal_resource_snapshots',
    'personal_resource_once_consumption_receipts'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY scoped_compute_capability_read ON %I.%I FOR SELECT USING '
      || '(current_user = %L AND opengeni_private.scoped_compute_capability_active())',
      data_schema, table_name, migration_owner
    );
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY[
    'rigs', 'rig_versions', 'enrollments', 'sandboxes',
    'organization_user_resource_authorities', 'organization_user_resource_grants'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY scoped_compute_capability_insert ON %I.%I FOR INSERT WITH CHECK '
      || '(current_user = %L AND opengeni_private.scoped_compute_capability_active(''write''))',
      data_schema, table_name, migration_owner
    );
    EXECUTE format(
      'CREATE POLICY scoped_compute_capability_update ON %I.%I FOR UPDATE USING '
      || '(current_user = %L AND opengeni_private.scoped_compute_capability_active(''write'')) '
      || 'WITH CHECK (current_user = %L AND '
      || 'opengeni_private.scoped_compute_capability_active(''write''))',
      data_schema, table_name, migration_owner, migration_owner
    );
  END LOOP;
END
$policies$;

CREATE OR REPLACE FUNCTION scoped_compute_actor_membership(
  p_account_id uuid,
  p_workspace_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  caller_subject text := nullif(pg_catalog.current_setting('opengeni.subject_id', true), '');
  membership_id uuid;
  personal_workspace_id uuid;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.workspace_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'scoped compute actor scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT membership.id, membership.personal_workspace_id
    INTO membership_id, personal_workspace_id
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = caller_subject
    AND membership.status = 'active' AND membership.revoked_at IS NULL
  FOR SHARE;
  IF membership_id IS NULL THEN RETURN NULL; END IF;
  IF personal_workspace_id IS DISTINCT FROM p_workspace_id THEN
    PERFORM 1 FROM workspace_memberships workspace_membership
    WHERE workspace_membership.account_id = p_account_id
      AND workspace_membership.workspace_id = p_workspace_id
      AND workspace_membership.subject_id = caller_subject
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'scoped compute actor lacks current workspace access'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN membership_id;
END
$$;
REVOKE ALL ON FUNCTION scoped_compute_actor_membership(uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION scoped_rig_json(p_rig_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', rig.id, 'accountId', rig.account_id, 'workspaceId', rig.workspace_id,
    'scope', rig.authority_scope, 'generation', rig.generation, 'status', rig.status,
    'name', rig.name, 'description', rig.description, 'createdBy', rig.created_by,
    'activeVersion', (
      SELECT pg_catalog.jsonb_build_object(
        'id', version.id, 'rigId', version.rig_id, 'version', version.version,
        'image', version.image, 'setupScript', version.setup_script,
        'checks', version.checks, 'credentialHooks', version.credential_hooks,
        'defaultVariableSetIds', version.default_variable_set_ids,
        'changelog', version.changelog, 'providerImages', version.provider_images,
        'createdBy', version.created_by, 'active', version.active,
        'createdAt', version.created_at
      ) FROM rig_versions version
      WHERE version.rig_id = rig.id AND version.account_id = rig.account_id
        AND version.active = true LIMIT 1
    ),
    'activeVersionHealth', CASE WHEN EXISTS (
      SELECT 1 FROM rig_versions version
      WHERE version.rig_id = rig.id AND version.account_id = rig.account_id
        AND version.active = true
    ) THEN pg_catalog.jsonb_build_object('checkHealth', 'unknown', 'lastVerifiedAt', NULL)
      ELSE NULL END,
    'versionCount', (SELECT count(*)::integer FROM rig_versions version
      WHERE version.rig_id = rig.id AND version.account_id = rig.account_id),
    'createdAt', rig.created_at, 'updatedAt', rig.updated_at
  ) FROM rigs rig WHERE rig.id = p_rig_id
$$;
REVOKE ALL ON FUNCTION scoped_rig_json(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION list_scoped_rigs(
  p_account_id uuid,
  p_workspace_id uuid,
  p_rig_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_scope text DEFAULT NULL
) RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  actor_membership_id uuid;
  rig_row record;
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'read')
  ON CONFLICT DO NOTHING;
  actor_membership_id := scoped_compute_actor_membership(p_account_id, p_workspace_id);
  IF p_scope IS NOT NULL AND p_scope NOT IN ('organization', 'workspace', 'user') THEN
    RAISE EXCEPTION 'invalid rig scope' USING ERRCODE = '22023';
  END IF;
  FOR rig_row IN
    SELECT rig.id FROM rigs rig
    WHERE rig.account_id = p_account_id AND rig.status = 'active'
      AND (p_rig_id IS NULL OR rig.id = p_rig_id)
      AND (p_name IS NULL OR rig.name = p_name)
      AND (p_scope IS NULL OR rig.authority_scope = p_scope)
      AND (
        rig.authority_scope = 'organization'
        OR (rig.authority_scope = 'workspace' AND rig.workspace_id = p_workspace_id)
        OR (rig.authority_scope = 'user'
          AND rig.owner_organization_membership_id = actor_membership_id)
      )
    ORDER BY CASE rig.authority_scope WHEN 'user' THEN 1 WHEN 'workspace' THEN 2 ELSE 3 END,
      rig.created_at, rig.id
  LOOP
    RETURN NEXT scoped_rig_json(rig_row.id);
  END LOOP;
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'read';
  RETURN;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'read';
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION list_scoped_rigs(uuid, uuid, uuid, text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION count_scoped_rigs(
  p_account_id uuid, p_workspace_id uuid, p_scope text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE actor_membership_id uuid; result_count integer;
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'read')
  ON CONFLICT DO NOTHING;
  actor_membership_id := scoped_compute_actor_membership(p_account_id, p_workspace_id);
  IF p_scope NOT IN ('organization', 'workspace', 'user') THEN
    RAISE EXCEPTION 'invalid rig scope' USING ERRCODE = '22023';
  END IF;
  SELECT count(*)::integer INTO result_count FROM rigs rig
  WHERE rig.account_id = p_account_id AND rig.status = 'active'
    AND rig.authority_scope = p_scope
    AND (p_scope = 'organization'
      OR (p_scope = 'workspace' AND rig.workspace_id = p_workspace_id)
      OR (p_scope = 'user' AND rig.owner_organization_membership_id = actor_membership_id));
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'read';
  RETURN result_count;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'read';
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION count_scoped_rigs(uuid, uuid, text) FROM PUBLIC;

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
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
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
    created_by, active
  ) VALUES (
    p_account_id, p_workspace_id, rig_id, 1, p_initial_version ->> 'image',
    p_initial_version ->> 'setupScript', coalesce(p_initial_version -> 'checks', '[]'::jsonb),
    coalesce(p_initial_version -> 'credentialHooks', '[]'::jsonb),
    coalesce(p_initial_version -> 'defaultVariableSetIds', '[]'::jsonb),
    p_initial_version ->> 'changelog', '{}'::jsonb,
    coalesce(p_initial_version ->> 'createdBy', p_created_by), true
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

CREATE OR REPLACE FUNCTION mutate_scoped_rig(
  p_account_id uuid, p_workspace_id uuid, p_rig_id uuid, p_operation text,
  p_name text DEFAULT NULL, p_name_present boolean DEFAULT false,
  p_description text DEFAULT NULL, p_description_present boolean DEFAULT false,
  p_allow_organization boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  actor_membership_id uuid;
  rig_row rigs%ROWTYPE;
  active_sessions integer;
  result jsonb;
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'write')
  ON CONFLICT DO NOTHING;
  actor_membership_id := scoped_compute_actor_membership(p_account_id, p_workspace_id);
  SELECT rig.* INTO STRICT rig_row FROM rigs rig
  WHERE rig.id = p_rig_id AND rig.account_id = p_account_id AND rig.status = 'active'
    AND ((rig.authority_scope = 'organization' AND p_allow_organization)
      OR (rig.authority_scope = 'workspace' AND rig.workspace_id = p_workspace_id)
      OR (rig.authority_scope = 'user'
        AND rig.owner_organization_membership_id = actor_membership_id))
  FOR UPDATE;
  IF p_operation = 'update' THEN
    UPDATE rigs SET name = CASE WHEN p_name_present THEN p_name ELSE name END,
      description = CASE WHEN p_description_present THEN p_description ELSE description END,
      updated_at = clock_timestamp() WHERE id = p_rig_id;
  ELSIF p_operation = 'revoke' THEN
    SELECT count(*)::integer INTO active_sessions FROM sessions session_value
    WHERE session_value.account_id = p_account_id AND session_value.rig_id = p_rig_id
      AND session_value.status IN ('queued','running','requires_action','recovering','waiting_capacity');
    IF active_sessions > 0 THEN
      RAISE EXCEPTION 'rig remains attached to % active sessions', active_sessions
        USING ERRCODE = '23503';
    END IF;
    UPDATE rigs SET status = 'revoked', revoked_at = clock_timestamp(),
      generation = generation + 1, updated_at = clock_timestamp() WHERE id = p_rig_id;
    IF rig_row.authority_scope = 'user' THEN
      UPDATE organization_user_resource_authorities SET status = 'revoked',
        revoked_at = clock_timestamp(), generation = generation + 1,
        updated_at = clock_timestamp()
      WHERE id = rig_row.authority_id AND account_id = p_account_id AND status = 'active';
      UPDATE organization_user_resource_grants SET status = 'revoked',
        revoked_at = clock_timestamp(), generation = generation + 1,
        updated_at = clock_timestamp()
      WHERE authority_id = rig_row.authority_id AND account_id = p_account_id
        AND status = 'active';
    END IF;
  ELSE RAISE EXCEPTION 'invalid rig mutation' USING ERRCODE = '22023'; END IF;
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'write';
  IF p_operation = 'revoke' THEN RETURN NULL; END IF;
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'read')
  ON CONFLICT DO NOTHING;
  result := scoped_rig_json(p_rig_id);
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
REVOKE ALL ON FUNCTION mutate_scoped_rig(
  uuid, uuid, uuid, text, text, boolean, text, boolean, boolean
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION finalize_scoped_enrollment(
  p_account_id uuid, p_workspace_id uuid, p_scope text, p_pubkey text,
  p_has_display boolean, p_allow_screen_control boolean, p_os text, p_arch text,
  p_sandbox_name text, p_allow_organization boolean DEFAULT false
) RETURNS TABLE(enrollment_id uuid, sandbox_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  caller_subject text := nullif(pg_catalog.current_setting('opengeni.subject_id', true), '');
  owner_membership organization_memberships%ROWTYPE;
  existing_enrollment enrollments%ROWTYPE;
  created_enrollment_id uuid := pg_catalog.gen_random_uuid();
  created_authority_id uuid;
  selected_enrollment_id uuid;
  selected_sandbox_id uuid;
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
  THEN RAISE EXCEPTION 'invalid scoped enrollment request' USING ERRCODE = '42501';
  END IF;
  IF p_scope = 'organization' AND NOT p_allow_organization THEN
    RAISE EXCEPTION 'organization machine enrollment requires account authority'
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
      IF NOT FOUND THEN RAISE EXCEPTION 'machine owner lacks workspace access'
        USING ERRCODE = '42501'; END IF;
    END IF;
  END IF;

  SELECT enrollment.* INTO existing_enrollment FROM enrollments enrollment
  WHERE enrollment.account_id = p_account_id
    AND enrollment.authority_scope = p_scope
    AND enrollment.pubkey = p_pubkey
    AND ((p_scope = 'organization')
      OR (p_scope = 'workspace' AND enrollment.workspace_id = p_workspace_id)
      OR (p_scope = 'user'
        AND enrollment.owner_organization_membership_id = owner_membership.id))
  ORDER BY enrollment.created_at DESC LIMIT 1 FOR UPDATE;

  IF existing_enrollment.id IS NULL THEN
    IF p_scope = 'user' THEN
      created_authority_id := pg_catalog.gen_random_uuid();
      INSERT INTO organization_user_resource_authorities(
        id, account_id, organization_membership_id, resource_kind, resource_id,
        origin_workspace_id, generation, status
      ) VALUES (created_authority_id, p_account_id, owner_membership.id,
        'connected_machine', created_enrollment_id, p_workspace_id, 1, 'active');
    END IF;
    INSERT INTO enrollments(
      id, account_id, workspace_id, pubkey, exposure, has_display,
      allow_screen_control, os, arch, status, authority_scope, authority_id,
      owner_organization_membership_id, origin_workspace_id, generation
    ) VALUES (
      created_enrollment_id, p_account_id, p_workspace_id, p_pubkey,
      'whole-machine', p_has_display, p_allow_screen_control, p_os, p_arch, 'active',
      p_scope, created_authority_id,
      CASE WHEN p_scope = 'user' THEN owner_membership.id ELSE NULL END,
      p_workspace_id, 1
    );
    selected_enrollment_id := created_enrollment_id;
  ELSE
    UPDATE enrollments SET exposure = 'whole-machine', has_display = p_has_display,
      allow_screen_control = p_allow_screen_control, os = p_os, arch = p_arch,
      status = 'active', revoked_at = NULL,
      credential_generation = credential_generation + 1,
      generation = generation + 1, connection_instance_id = NULL,
      connection_lease_expires_at = NULL, updated_at = clock_timestamp()
    WHERE id = existing_enrollment.id;
    selected_enrollment_id := existing_enrollment.id;
  END IF;

  SELECT sandbox.id INTO selected_sandbox_id FROM sandboxes sandbox
  WHERE sandbox.account_id = p_account_id
    AND sandbox.enrollment_id = selected_enrollment_id
  ORDER BY sandbox.created_at LIMIT 1 FOR SHARE;
  IF selected_sandbox_id IS NULL THEN
    selected_sandbox_id := pg_catalog.gen_random_uuid();
    INSERT INTO sandboxes(id, account_id, workspace_id, kind, name, enrollment_id)
    VALUES (selected_sandbox_id, p_account_id, p_workspace_id, 'selfhosted',
      p_sandbox_name, selected_enrollment_id);
  END IF;
  enrollment_id := selected_enrollment_id;
  sandbox_id := selected_sandbox_id;
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'write';
  RETURN NEXT;
  RETURN;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION finalize_scoped_enrollment(
  uuid, uuid, text, text, boolean, boolean, text, text, text, boolean
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION list_scoped_enrollments(
  p_account_id uuid, p_workspace_id uuid, p_enrollment_id uuid DEFAULT NULL,
  p_status text DEFAULT 'active'
) RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE actor_membership_id uuid; enrollment_row record;
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'read')
  ON CONFLICT DO NOTHING;
  actor_membership_id := scoped_compute_actor_membership(p_account_id, p_workspace_id);
  IF p_status NOT IN ('active', 'revoked') THEN
    RAISE EXCEPTION 'invalid enrollment status' USING ERRCODE = '22023';
  END IF;
  FOR enrollment_row IN
    SELECT enrollment.*, sandbox.id AS sandbox_id, sandbox.name AS sandbox_name
    FROM enrollments enrollment
    LEFT JOIN LATERAL (
      SELECT value.id, value.name FROM sandboxes value
      WHERE value.enrollment_id = enrollment.id AND value.account_id = enrollment.account_id
      ORDER BY value.created_at LIMIT 1
    ) sandbox ON true
    WHERE enrollment.account_id = p_account_id AND enrollment.status = p_status
      AND (p_enrollment_id IS NULL OR enrollment.id = p_enrollment_id)
      AND (enrollment.authority_scope = 'organization'
        OR (enrollment.authority_scope = 'workspace'
          AND enrollment.workspace_id = p_workspace_id)
        OR (enrollment.authority_scope = 'user'
          AND enrollment.owner_organization_membership_id = actor_membership_id))
    ORDER BY enrollment.created_at DESC, enrollment.id
  LOOP
    RETURN NEXT pg_catalog.jsonb_build_object(
      'id', enrollment_row.id, 'accountId', enrollment_row.account_id,
      'workspaceId', enrollment_row.workspace_id, 'scope', enrollment_row.authority_scope,
      'generation', enrollment_row.generation, 'pubkey', enrollment_row.pubkey,
      'exposure', enrollment_row.exposure, 'hasDisplay', enrollment_row.has_display,
      'opStream', enrollment_row.op_stream,
      'desktopUnavailableReason', enrollment_row.desktop_unavailable_reason,
      'allowScreenControl', enrollment_row.allow_screen_control,
      'operationPolicy', pg_catalog.jsonb_build_object(
        'memoryMaxBytes', enrollment_row.operation_memory_max_bytes,
        'memoryHighBytes', enrollment_row.operation_memory_high_bytes,
        'cpuMaxMillicores', enrollment_row.operation_cpu_max_millicores,
        'revision', enrollment_row.operation_policy_revision,
        'updatedAt', enrollment_row.operation_policy_updated_at
      ),
      'status', enrollment_row.status,
      'credentialGeneration', enrollment_row.credential_generation,
      'connectionInstanceId', enrollment_row.connection_instance_id,
      'connectionGeneration', enrollment_row.connection_generation,
      'connectionLeaseExpiresAt', enrollment_row.connection_lease_expires_at,
      'connectionDuplicateDeniedCount', enrollment_row.connection_duplicate_denied_count,
      'connectionDuplicateDeniedAt', enrollment_row.connection_duplicate_denied_at,
      'os', enrollment_row.os, 'arch', enrollment_row.arch,
      'lastSeenAt', enrollment_row.last_seen_at,
      'wentOfflineAt', enrollment_row.went_offline_at,
      'wentOfflineReason', enrollment_row.went_offline_reason,
      'agentVersion', enrollment_row.agent_version,
      'agentBinarySha256', enrollment_row.agent_binary_sha256,
      'agentUpdateChannel', enrollment_row.agent_update_channel,
      'agentCapabilities', enrollment_row.agent_capabilities,
      'agentUpdate', NULL, 'sandboxId', enrollment_row.sandbox_id,
      'sandboxName', enrollment_row.sandbox_name,
      'createdAt', enrollment_row.created_at, 'revokedAt', enrollment_row.revoked_at,
      'updatedAt', enrollment_row.updated_at
    );
  END LOOP;
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'read';
  RETURN;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION list_scoped_enrollments(uuid, uuid, uuid, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION get_scoped_sandbox(
  p_account_id uuid, p_workspace_id uuid, p_sandbox_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE actor_membership_id uuid; result jsonb;
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'read')
  ON CONFLICT DO NOTHING;
  actor_membership_id := scoped_compute_actor_membership(p_account_id, p_workspace_id);
  SELECT pg_catalog.jsonb_build_object(
    'id', sandbox.id, 'accountId', sandbox.account_id,
    'workspaceId', sandbox.workspace_id, 'kind', sandbox.kind, 'name', sandbox.name,
    'enrollmentId', sandbox.enrollment_id, 'createdAt', sandbox.created_at,
    'updatedAt', sandbox.updated_at, 'scope', enrollment.authority_scope,
    'generation', enrollment.generation
  ) INTO result
  FROM sandboxes sandbox
  LEFT JOIN enrollments enrollment
    ON enrollment.id = sandbox.enrollment_id AND enrollment.account_id = sandbox.account_id
  WHERE sandbox.id = p_sandbox_id AND sandbox.account_id = p_account_id
    AND (
      sandbox.kind <> 'selfhosted'
        AND sandbox.workspace_id = p_workspace_id
      OR sandbox.kind = 'selfhosted' AND enrollment.status = 'active' AND (
        enrollment.authority_scope = 'organization'
        OR (enrollment.authority_scope = 'workspace'
          AND enrollment.workspace_id = p_workspace_id)
        OR (enrollment.authority_scope = 'user'
          AND enrollment.owner_organization_membership_id = actor_membership_id)
      )
    );
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
REVOKE ALL ON FUNCTION get_scoped_sandbox(uuid, uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION authorize_scoped_sandbox_attach(
  p_account_id uuid, p_workspace_id uuid, p_sandbox_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  actor_membership_id uuid;
  sandbox_row sandboxes%ROWTYPE;
  enrollment_row enrollments%ROWTYPE;
  authorized boolean := false;
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'read')
  ON CONFLICT DO NOTHING;
  actor_membership_id := scoped_compute_actor_membership(p_account_id, p_workspace_id);
  SELECT sandbox.* INTO sandbox_row FROM sandboxes sandbox
  WHERE sandbox.id = p_sandbox_id AND sandbox.account_id = p_account_id FOR SHARE;
  IF sandbox_row.id IS NOT NULL AND sandbox_row.kind <> 'selfhosted' THEN
    authorized := sandbox_row.workspace_id = p_workspace_id;
  ELSIF sandbox_row.id IS NOT NULL THEN
    SELECT enrollment.* INTO enrollment_row FROM enrollments enrollment
    WHERE enrollment.id = sandbox_row.enrollment_id
      AND enrollment.account_id = p_account_id AND enrollment.status = 'active'
    FOR SHARE;
    authorized := enrollment_row.id IS NOT NULL AND (
      enrollment_row.authority_scope = 'organization'
      OR (enrollment_row.authority_scope = 'workspace'
        AND enrollment_row.workspace_id = p_workspace_id)
      OR (enrollment_row.authority_scope = 'user'
        AND enrollment_row.owner_organization_membership_id = actor_membership_id)
    );
  END IF;
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'read';
  RETURN authorized;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION authorize_scoped_sandbox_attach(uuid, uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION materialize_scoped_rig_version_for_attempt(
  p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid,
  p_attempt_id uuid, p_execution_generation integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  session_row sessions%ROWTYPE;
  rig_row rigs%ROWTYPE;
  version_row rig_versions%ROWTYPE;
  initiating_subject text;
  resolved_count integer;
  result jsonb;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.workspace_id', true), '')::uuid
  THEN RAISE EXCEPTION 'rig runtime scope mismatch' USING ERRCODE = '42501'; END IF;
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'runtime')
  ON CONFLICT DO NOTHING;
  SELECT session_value.* INTO STRICT session_row
  FROM sessions session_value
  JOIN session_turns turn_value ON turn_value.id = p_turn_id
    AND turn_value.account_id = session_value.account_id
    AND turn_value.workspace_id = session_value.workspace_id
    AND turn_value.session_id = session_value.id
  JOIN session_turn_attempts attempt ON attempt.id = p_attempt_id
    AND attempt.account_id = session_value.account_id
    AND attempt.workspace_id = session_value.workspace_id
    AND attempt.session_id = session_value.id AND attempt.turn_id = turn_value.id
  WHERE session_value.id = p_session_id AND session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id
    AND session_value.active_turn_id = p_turn_id
    AND turn_value.active_attempt_id = p_attempt_id
    AND turn_value.execution_generation = p_execution_generation
    AND turn_value.status = 'running'
    AND attempt.execution_generation = p_execution_generation
    AND attempt.state IN ('claimed','running') AND attempt.closed_at IS NULL
    AND attempt.quiesced_at IS NULL
  FOR SHARE OF session_value, turn_value, attempt;
  initiating_subject := coalesce(
    nullif(pg_catalog.current_setting('opengeni.initiating_human_subject_id', true), ''),
    nullif(pg_catalog.current_setting('opengeni.subject_id', true), '')
  );
  SELECT rig.* INTO STRICT rig_row FROM rigs rig
  WHERE rig.id = session_row.rig_id AND rig.account_id = p_account_id
    AND rig.status = 'active' FOR SHARE;
  SELECT version.* INTO STRICT version_row FROM rig_versions version
  WHERE version.id = session_row.rig_version_id AND version.rig_id = rig_row.id
    AND version.account_id = p_account_id FOR SHARE;
  IF rig_row.authority_scope = 'workspace'
    AND rig_row.workspace_id IS DISTINCT FROM p_workspace_id
  THEN RAISE EXCEPTION 'workspace rig is outside the runtime workspace'
    USING ERRCODE = '42501';
  ELSIF rig_row.authority_scope = 'user' THEN
    SELECT count(*)::integer INTO resolved_count
    FROM resolve_session_attempt_personal_resources(
      p_account_id, p_workspace_id, p_attempt_id
    ) resolved
    WHERE resolved.resource_kind = 'rig' AND resolved.resource_id = rig_row.id
      AND resolved.resource_version_id = version_row.id
      AND resolved.authority_id = rig_row.authority_id
      AND resolved.authority_generation = rig_row.generation;
    IF resolved_count <> 1 THEN
      RAISE EXCEPTION 'personal rig grant is not exact or current'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  result := pg_catalog.jsonb_build_object(
    'rigName', rig_row.name,
    'version', pg_catalog.jsonb_build_object(
      'id', version_row.id, 'rigId', version_row.rig_id,
      'version', version_row.version, 'image', version_row.image,
      'setupScript', version_row.setup_script, 'checks', version_row.checks,
      'credentialHooks', version_row.credential_hooks,
      'defaultVariableSetIds', version_row.default_variable_set_ids,
      'changelog', version_row.changelog, 'providerImages', version_row.provider_images,
      'createdBy', version_row.created_by, 'active', version_row.active,
      'createdAt', version_row.created_at
    )
  );
  INSERT INTO audit_events(
    account_id, workspace_id, subject_id, action, target_type, target_id,
    metadata, metadata_codec_version
  ) VALUES (
    p_account_id, p_workspace_id, initiating_subject, 'rig.materialized', 'rig',
    rig_row.id::text, pg_catalog.jsonb_build_object(
      'scope', rig_row.authority_scope, 'generation', rig_row.generation,
      'versionId', version_row.id, 'sessionId', p_session_id,
      'turnId', p_turn_id, 'attemptId', p_attempt_id,
      'executionGeneration', p_execution_generation
    ), 1
  );
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'runtime';
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION materialize_scoped_rig_version_for_attempt(
  uuid, uuid, uuid, uuid, uuid, integer
) FROM PUBLIC;

CREATE TABLE session_attempt_connected_machine_authorizations (
  attempt_id uuid PRIMARY KEY REFERENCES session_turn_attempts(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  execution_generation integer NOT NULL,
  initiating_human_subject_id text NOT NULL,
  owner_organization_membership_id uuid NOT NULL,
  membership_authorization_revision bigint NOT NULL,
  enrollment_id uuid NOT NULL,
  sandbox_id uuid NOT NULL,
  authority_id uuid NOT NULL,
  authority_generation bigint NOT NULL,
  enrollment_generation bigint NOT NULL,
  session_visibility text NOT NULL,
  session_authority_epoch bigint NOT NULL,
  grant_id uuid NOT NULL,
  grant_generation bigint NOT NULL,
  grant_mode text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT session_attempt_connected_machine_attempt_fk FOREIGN KEY (
    account_id, workspace_id, session_id, turn_id, attempt_id
  ) REFERENCES session_turn_attempts(
    account_id, workspace_id, session_id, turn_id, id
  ) ON DELETE CASCADE,
  CONSTRAINT session_attempt_connected_machine_owner_fk FOREIGN KEY (
    owner_organization_membership_id, account_id
  ) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT session_attempt_connected_machine_authority_fk FOREIGN KEY (
    authority_id, account_id, owner_organization_membership_id
  ) REFERENCES organization_user_resource_authorities(
    id, account_id, organization_membership_id
  ) ON DELETE RESTRICT,
  CONSTRAINT session_attempt_connected_machine_grant_fk FOREIGN KEY (
    grant_id, account_id
  ) REFERENCES organization_user_resource_grants(
    id, account_id
  ) ON DELETE RESTRICT
);
ALTER TABLE session_attempt_connected_machine_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_attempt_connected_machine_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY scoped_compute_capability_read
  ON session_attempt_connected_machine_authorizations FOR SELECT
  USING (opengeni_private.scoped_compute_capability_active());
CREATE POLICY scoped_compute_capability_insert
  ON session_attempt_connected_machine_authorizations FOR INSERT
  WITH CHECK (opengeni_private.scoped_compute_capability_active('write'));

CREATE OR REPLACE FUNCTION admit_session_attempt_personal_machine() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  session_row sessions%ROWTYPE;
  turn_row session_turns%ROWTYPE;
  enrollment_row enrollments%ROWTYPE;
  sandbox_row sandboxes%ROWTYPE;
  member_row organization_memberships%ROWTYPE;
  grant_row organization_user_resource_grants%ROWTYPE;
  initiating_subject text;
  affected integer;
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'write')
  ON CONFLICT DO NOTHING;
  SELECT session_value.* INTO STRICT session_row FROM sessions session_value
  WHERE session_value.id = NEW.session_id AND session_value.account_id = NEW.account_id
    AND session_value.workspace_id = NEW.workspace_id FOR SHARE;
  IF session_row.active_sandbox_id IS NULL THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
    RETURN NEW;
  END IF;
  SELECT sandbox.* INTO sandbox_row FROM sandboxes sandbox
  WHERE sandbox.id = session_row.active_sandbox_id AND sandbox.account_id = NEW.account_id
    AND sandbox.kind = 'selfhosted' FOR SHARE;
  IF sandbox_row.enrollment_id IS NULL THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
    RETURN NEW;
  END IF;
  SELECT enrollment.* INTO enrollment_row FROM enrollments enrollment
  WHERE enrollment.id = sandbox_row.enrollment_id AND enrollment.account_id = NEW.account_id
    AND enrollment.authority_scope = 'user' AND enrollment.status = 'active' FOR SHARE;
  IF enrollment_row.id IS NULL THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
    RETURN NEW;
  END IF;
  SELECT turn_value.* INTO STRICT turn_row FROM session_turns turn_value
  WHERE turn_value.id = NEW.turn_id AND turn_value.account_id = NEW.account_id
    AND turn_value.workspace_id = NEW.workspace_id
    AND turn_value.session_id = NEW.session_id FOR SHARE;
  IF NEW.state NOT IN ('claimed', 'running') OR NEW.closed_at IS NOT NULL
    OR NEW.quiesced_at IS NOT NULL OR session_row.active_turn_id IS DISTINCT FROM NEW.turn_id
    OR turn_row.active_attempt_id IS DISTINCT FROM NEW.id
    OR turn_row.execution_generation IS DISTINCT FROM NEW.execution_generation
    OR NEW.authority_visibility IS DISTINCT FROM session_row.visibility
    OR NEW.authority_epoch IS DISTINCT FROM session_row.authority_epoch
  THEN RAISE EXCEPTION 'personal machine requires exact current attempt authority'
    USING ERRCODE = '42501'; END IF;
  initiating_subject := coalesce(nullif(btrim(turn_row.initiating_human_subject_id), ''),
    CASE WHEN turn_row.initiator_kind = 'subject'
      THEN nullif(btrim(turn_row.initiator_subject_id), '') END);
  SELECT membership.* INTO STRICT member_row FROM organization_memberships membership
  WHERE membership.account_id = NEW.account_id AND membership.subject_id = initiating_subject
    AND membership.status = 'active' AND membership.revoked_at IS NULL FOR SHARE;
  IF member_row.id IS DISTINCT FROM enrollment_row.owner_organization_membership_id THEN
    RAISE EXCEPTION 'only the personal machine owner may attach it'
      USING ERRCODE = '42501';
  END IF;
  IF member_row.personal_workspace_id IS DISTINCT FROM NEW.workspace_id THEN
    PERFORM 1 FROM workspace_memberships workspace_membership
    WHERE workspace_membership.account_id = NEW.account_id
      AND workspace_membership.workspace_id = NEW.workspace_id
      AND workspace_membership.subject_id = initiating_subject FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'machine owner lacks target workspace access'
      USING ERRCODE = '42501'; END IF;
  END IF;
  PERFORM 1 FROM organization_user_resource_authorities authority
  WHERE authority.id = enrollment_row.authority_id AND authority.account_id = NEW.account_id
    AND authority.organization_membership_id = member_row.id
    AND authority.resource_kind = 'connected_machine'
    AND authority.resource_id = enrollment_row.id
    AND authority.generation = enrollment_row.generation
    AND authority.status = 'active' AND authority.revoked_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'personal machine authority is stale'
    USING ERRCODE = '42501'; END IF;
  SELECT grant_value.* INTO grant_row FROM organization_user_resource_grants grant_value
  WHERE grant_value.account_id = NEW.account_id
    AND grant_value.authority_id = enrollment_row.authority_id
    AND grant_value.owner_organization_membership_id = member_row.id
    AND grant_value.workspace_id = NEW.workspace_id
    AND grant_value.action = 'connected_machine.use'
    AND grant_value.context = session_row.visibility AND grant_value.status = 'active'
    AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
    AND ((grant_value.mode IN ('once','session')
        AND grant_value.session_id = NEW.session_id
        AND grant_value.authority_epoch = session_row.authority_epoch)
      OR (grant_value.mode = 'always' AND grant_value.session_id IS NULL
        AND grant_value.authority_epoch IS NULL))
  ORDER BY CASE grant_value.mode WHEN 'once' THEN 1 WHEN 'session' THEN 2 ELSE 3 END,
    grant_value.generation DESC, grant_value.id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'personal machine use requires explicit grant'
    USING ERRCODE = '42501'; END IF;
  INSERT INTO session_attempt_connected_machine_authorizations(
    attempt_id, account_id, workspace_id, session_id, turn_id, execution_generation,
    initiating_human_subject_id, owner_organization_membership_id,
    membership_authorization_revision, enrollment_id, sandbox_id, authority_id,
    authority_generation, enrollment_generation, session_visibility,
    session_authority_epoch, grant_id, grant_generation, grant_mode
  ) SELECT NEW.id, NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id,
    NEW.execution_generation, initiating_subject, member_row.id,
    member_row.authorization_revision, enrollment_row.id, sandbox_row.id,
    authority.id, authority.generation, enrollment_row.generation,
    session_row.visibility, session_row.authority_epoch,
    grant_row.id, grant_row.generation, grant_row.mode
  FROM organization_user_resource_authorities authority
  WHERE authority.id = enrollment_row.authority_id AND authority.account_id = NEW.account_id;
  IF grant_row.mode = 'once' THEN
    UPDATE organization_user_resource_grants SET status = 'consumed',
      updated_at = clock_timestamp()
    WHERE id = grant_row.id AND account_id = NEW.account_id
      AND generation = grant_row.generation AND status = 'active';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN RAISE EXCEPTION 'once machine grant lost first-use race'
      USING ERRCODE = '40001'; END IF;
    INSERT INTO personal_resource_once_consumption_receipts(
      grant_id, account_id, attempt_id, workspace_id, session_id, turn_id,
      execution_generation, authority_id, authority_generation, grant_generation
    ) SELECT grant_row.id, NEW.account_id, NEW.id, NEW.workspace_id, NEW.session_id,
      NEW.turn_id, NEW.execution_generation, authority.id, authority.generation,
      grant_row.generation FROM organization_user_resource_authorities authority
    WHERE authority.id = enrollment_row.authority_id AND authority.account_id = NEW.account_id;
  END IF;
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'write';
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$$;
DROP TRIGGER IF EXISTS z_session_attempt_personal_machine_admission ON session_turn_attempts;
CREATE TRIGGER z_session_attempt_personal_machine_admission
AFTER INSERT ON session_turn_attempts FOR EACH ROW
EXECUTE FUNCTION admit_session_attempt_personal_machine();
REVOKE ALL ON FUNCTION admit_session_attempt_personal_machine() FROM PUBLIC;

CREATE OR REPLACE FUNCTION assert_session_attempt_personal_machine(
  p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid,
  p_attempt_id uuid, p_execution_generation integer, p_enrollment_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  authorization_row session_attempt_connected_machine_authorizations%ROWTYPE;
  caller_subject text := coalesce(
    nullif(pg_catalog.current_setting('opengeni.initiating_human_subject_id', true), ''),
    nullif(pg_catalog.current_setting('opengeni.subject_id', true), '')
  );
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.workspace_id', true), '')::uuid
  THEN RAISE EXCEPTION 'machine runtime scope mismatch' USING ERRCODE = '42501'; END IF;
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'runtime')
  ON CONFLICT DO NOTHING;
  SELECT authorization_value.* INTO authorization_row
  FROM session_attempt_connected_machine_authorizations authorization_value
  WHERE authorization_value.attempt_id = p_attempt_id
    AND authorization_value.account_id = p_account_id
    AND authorization_value.workspace_id = p_workspace_id
    AND authorization_value.session_id = p_session_id
    AND authorization_value.turn_id = p_turn_id
    AND authorization_value.execution_generation = p_execution_generation
    AND authorization_value.enrollment_id = p_enrollment_id;
  IF authorization_row.attempt_id IS NULL THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND capability_kind = 'runtime';
    RETURN false;
  END IF;
  IF caller_subject IS DISTINCT FROM authorization_row.initiating_human_subject_id
    OR NOT EXISTS (
      SELECT 1 FROM sessions session_value
      JOIN session_turns turn_value ON turn_value.id = p_turn_id
        AND turn_value.account_id = session_value.account_id
        AND turn_value.workspace_id = session_value.workspace_id
        AND turn_value.session_id = session_value.id
      JOIN session_turn_attempts attempt ON attempt.id = p_attempt_id
        AND attempt.turn_id = turn_value.id AND attempt.session_id = session_value.id
        AND attempt.account_id = session_value.account_id
        AND attempt.workspace_id = session_value.workspace_id
      JOIN sandboxes sandbox ON sandbox.id = session_value.active_sandbox_id
      WHERE session_value.id = p_session_id AND session_value.account_id = p_account_id
        AND session_value.workspace_id = p_workspace_id
        AND session_value.active_turn_id = p_turn_id
        AND session_value.active_sandbox_id = authorization_row.sandbox_id
        AND session_value.visibility = authorization_row.session_visibility
        AND session_value.authority_epoch = authorization_row.session_authority_epoch
        AND turn_value.active_attempt_id = p_attempt_id
        AND turn_value.execution_generation = p_execution_generation
        AND turn_value.status = 'running'
        AND attempt.execution_generation = p_execution_generation
        AND attempt.state IN ('claimed','running') AND attempt.closed_at IS NULL
        AND attempt.quiesced_at IS NULL
        AND sandbox.enrollment_id = p_enrollment_id
    )
    OR EXISTS (
      SELECT 1 FROM session_attempt_interruptions interruption
      WHERE interruption.attempt_id = p_attempt_id AND interruption.account_id = p_account_id
        AND interruption.workspace_id = p_workspace_id
        AND interruption.state IN ('pending','delivered','acknowledged')
    )
    OR NOT EXISTS (
      SELECT 1 FROM organization_memberships membership
      WHERE membership.id = authorization_row.owner_organization_membership_id
        AND membership.account_id = p_account_id
        AND membership.subject_id = authorization_row.initiating_human_subject_id
        AND membership.status = 'active' AND membership.revoked_at IS NULL
        AND membership.authorization_revision
          = authorization_row.membership_authorization_revision
        AND (membership.personal_workspace_id = p_workspace_id OR EXISTS (
          SELECT 1 FROM workspace_memberships workspace_membership
          WHERE workspace_membership.account_id = p_account_id
            AND workspace_membership.workspace_id = p_workspace_id
            AND workspace_membership.subject_id = membership.subject_id
        ))
    )
    OR NOT EXISTS (
      SELECT 1 FROM enrollments enrollment
      WHERE enrollment.id = p_enrollment_id AND enrollment.account_id = p_account_id
        AND enrollment.authority_scope = 'user'
        AND enrollment.owner_organization_membership_id
          = authorization_row.owner_organization_membership_id
        AND enrollment.authority_id = authorization_row.authority_id
        AND enrollment.generation = authorization_row.enrollment_generation
        AND enrollment.status = 'active' AND enrollment.revoked_at IS NULL
    )
    OR NOT EXISTS (
      SELECT 1 FROM organization_user_resource_authorities authority
      WHERE authority.id = authorization_row.authority_id
        AND authority.account_id = p_account_id
        AND authority.organization_membership_id
          = authorization_row.owner_organization_membership_id
        AND authority.resource_kind = 'connected_machine'
        AND authority.resource_id = p_enrollment_id
        AND authority.generation = authorization_row.authority_generation
        AND authority.status = 'active' AND authority.revoked_at IS NULL
    )
    OR NOT EXISTS (
      SELECT 1 FROM organization_user_resource_grants grant_value
      WHERE grant_value.id = authorization_row.grant_id
        AND grant_value.account_id = p_account_id
        AND grant_value.authority_id = authorization_row.authority_id
        AND grant_value.generation = authorization_row.grant_generation
        AND grant_value.action = 'connected_machine.use'
        AND grant_value.context = authorization_row.session_visibility
        AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
        AND ((authorization_row.grant_mode = 'once' AND grant_value.status = 'consumed'
          AND EXISTS (SELECT 1 FROM personal_resource_once_consumption_receipts receipt
            WHERE receipt.grant_id = grant_value.id AND receipt.attempt_id = p_attempt_id
              AND receipt.account_id = p_account_id))
          OR (authorization_row.grant_mode IN ('session','always')
            AND grant_value.status = 'active'))
    )
  THEN RAISE EXCEPTION 'personal machine authority is no longer live'
    USING ERRCODE = '42501'; END IF;
  INSERT INTO audit_events(
    account_id, workspace_id, subject_id, action, target_type, target_id,
    metadata, metadata_codec_version
  ) VALUES (
    p_account_id, p_workspace_id, authorization_row.initiating_human_subject_id,
    'connected_machine.used', 'enrollment', p_enrollment_id::text,
    pg_catalog.jsonb_build_object(
      'ownerOrganizationMembershipId', authorization_row.owner_organization_membership_id,
      'scope', 'user', 'sessionId', p_session_id, 'turnId', p_turn_id,
      'attemptId', p_attempt_id, 'executionGeneration', p_execution_generation,
      'generation', authorization_row.enrollment_generation
    ), 1
  );
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability_kind = 'runtime';
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scoped_compute_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$$;
REVOKE ALL ON FUNCTION assert_session_attempt_personal_machine(
  uuid, uuid, uuid, uuid, uuid, integer, uuid
) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION list_scoped_rigs(uuid, uuid, uuid, text, text)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION count_scoped_rigs(uuid, uuid, text) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION create_scoped_rig(
      uuid, uuid, text, text, text, text, jsonb, boolean
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION mutate_scoped_rig(
      uuid, uuid, uuid, text, text, boolean, text, boolean, boolean
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION finalize_scoped_enrollment(
      uuid, uuid, text, text, boolean, boolean, text, text, text, boolean
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION list_scoped_enrollments(uuid, uuid, uuid, text)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION get_scoped_sandbox(uuid, uuid, uuid) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION authorize_scoped_sandbox_attach(uuid, uuid, uuid)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION materialize_scoped_rig_version_for_attempt(
      uuid, uuid, uuid, uuid, uuid, integer
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION assert_session_attempt_personal_machine(
      uuid, uuid, uuid, uuid, uuid, integer, uuid
    ) TO opengeni_app;
    REVOKE ALL ON TABLE opengeni_private.scoped_compute_capabilities FROM opengeni_app;
    REVOKE ALL ON TABLE session_attempt_connected_machine_authorizations
      FROM opengeni_app;
    REVOKE ALL ON TABLE organization_user_resource_authorities FROM opengeni_app;
    REVOKE ALL ON TABLE organization_user_resource_grants FROM opengeni_app;
  END IF;
END
$grants$;

COMMENT ON COLUMN rigs.authority_scope IS
  'Explicit owner scope: organization, workspace, or organization+user.';
COMMENT ON COLUMN enrollments.authority_scope IS
  'Connected Machine owner scope; human approval defaults to organization+user.';
COMMENT ON FUNCTION assert_session_attempt_personal_machine(
  uuid, uuid, uuid, uuid, uuid, integer, uuid
) IS 'Revalidates exact personal-machine owner, membership, grant, session authority, and generation immediately before machine use.';
