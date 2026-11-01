-- deployment-mode: rolling
-- An organization's machines and rigs work in the workspaces it picks
-- (docs/design/ownership-and-reach.md, rule 3), with the same reach columns
-- as the organization's model keys and connectors: every shared workspace
-- (allowed_workspace_ids IS NULL) or the listed ones, and a separate switch
-- for members' Personal workspaces. The workspace a machine was connected
-- from, or a rig was made in, always has it: that is where its rows live, so
-- the workspace's own reads keep seeing it there.
--
-- Before this, an organization machine or rig worked in every workspace of the
-- organization, Personal ones included. Existing rows keep exactly that reach
-- (NULL, true), and so does every row the previous release inserts.
--
-- The five functions that decide whether a workspace's turns can see or use
-- an organization machine or rig now also ask where it works:
-- list_scoped_enrollments, get_scoped_sandbox and
-- authorize_scoped_sandbox_attach for machines (attempt resolution and the
-- fleet tools go through them), list_scoped_rigs and
-- materialize_scoped_rig_version_for_attempt for rigs (scheduled runs
-- materialize their rig per attempt). list_scoped_enrollments and
-- scoped_rig_json also report it as `reach` for organization ones. Everything
-- else in them is unchanged.
--
-- One fix rides along in materialize_scoped_rig_version_for_attempt: it read
-- the rig and its version FOR SHARE, and a row lock also needs the rows'
-- update policy, which only the workspace the rig lives in passes. So a chat
-- in any other workspace could not use an organization rig (or an Only me rig
-- made elsewhere) at all: "query returned no rows". It now reads them without
-- a lock. Versions never change, and revoking a rig already refuses while any
-- session on it is running, so the lock guarded nothing a running attempt
-- needs.
--
-- organization_compute_reaches_v1 is a pure helper with no table access; the
-- definers above look up the workspace's kind once and pass it in.
--
-- Same signatures, so grants are kept. Rolling: the previous release reads
-- nothing new, ignores the extra `reach` key, and its inserts take the
-- defaults, which keep today's reach.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE enrollments
  ADD COLUMN allowed_workspace_ids uuid[],
  ADD COLUMN allow_personal_workspaces boolean NOT NULL DEFAULT true;

ALTER TABLE rigs
  ADD COLUMN allowed_workspace_ids uuid[],
  ADD COLUMN allow_personal_workspaces boolean NOT NULL DEFAULT true;

-- Whether an organization machine or rig works in a workspace: always where
-- it lives, in a Personal workspace when the Personal switch is on, and in a
-- shared workspace when it works in all of them or that one is listed.
CREATE FUNCTION opengeni_private.organization_compute_reaches_v1(
  p_workspace_id uuid, p_workspace_personal boolean, p_home_workspace_id uuid,
  p_allowed_workspace_ids uuid[], p_allow_personal_workspaces boolean
) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path = pg_catalog, pg_temp
    AS $$
  SELECT CASE
    WHEN p_workspace_id IS NULL THEN false
    WHEN p_workspace_id = p_home_workspace_id THEN true
    WHEN p_workspace_personal THEN coalesce(p_allow_personal_workspaces, false)
    ELSE p_allowed_workspace_ids IS NULL OR p_workspace_id = ANY (p_allowed_workspace_ids)
  END
$$;
REVOKE ALL ON FUNCTION opengeni_private.organization_compute_reaches_v1(uuid, boolean, uuid, uuid[], boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION list_scoped_enrollments(p_account_id uuid, p_workspace_id uuid, p_enrollment_id uuid DEFAULT NULL::uuid, p_status text DEFAULT 'active'::text) RETURNS SETOF jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE actor_membership_id uuid; enrollment_row record; workspace_personal boolean;
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'read')
  ON CONFLICT DO NOTHING;
  actor_membership_id := scoped_compute_actor_membership(p_account_id, p_workspace_id);
  workspace_personal := get_workspace_kind(p_account_id, p_workspace_id) = 'personal';
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
      AND enrollment.kind = 'machine'
      AND (p_enrollment_id IS NULL OR enrollment.id = p_enrollment_id)
      AND ((enrollment.authority_scope = 'organization'
          AND opengeni_private.organization_compute_reaches_v1(
            p_workspace_id, workspace_personal, enrollment.workspace_id,
            enrollment.allowed_workspace_ids, enrollment.allow_personal_workspaces))
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
      'workspaceRoot', enrollment_row.workspace_root,
      'lastSeenAt', enrollment_row.last_seen_at,
      'wentOfflineAt', enrollment_row.went_offline_at,
      'wentOfflineReason', enrollment_row.went_offline_reason,
      'agentVersion', enrollment_row.agent_version,
      'agentBinarySha256', enrollment_row.agent_binary_sha256,
      'agentUpdateChannel', enrollment_row.agent_update_channel,
      'agentCapabilities', enrollment_row.agent_capabilities,
      'agentUpdate', CASE WHEN enrollment_row.agent_update_operation_id IS NOT NULL
        AND enrollment_row.agent_update_status IS NOT NULL
        AND length(enrollment_row.agent_update_target_version) > 0
        AND enrollment_row.agent_update_connection_instance_id IS NOT NULL
        AND enrollment_row.agent_update_connection_generation IS NOT NULL
        AND enrollment_row.agent_update_requested_at IS NOT NULL
        AND enrollment_row.agent_update_updated_at IS NOT NULL
        THEN pg_catalog.jsonb_build_object(
          'operationId', enrollment_row.agent_update_operation_id,
          'status', enrollment_row.agent_update_status,
          'targetVersion', enrollment_row.agent_update_target_version,
          'expectedBinarySha256', enrollment_row.agent_update_expected_binary_sha256,
          'errorCode', enrollment_row.agent_update_error_code,
          'retryable', enrollment_row.agent_update_retryable,
          'rolledBack', enrollment_row.agent_update_rolled_back,
          'connectionInstanceId', enrollment_row.agent_update_connection_instance_id,
          'connectionGeneration', enrollment_row.agent_update_connection_generation,
          'requestedAt', enrollment_row.agent_update_requested_at,
          'updatedAt', enrollment_row.agent_update_updated_at,
          'completedAt', enrollment_row.agent_update_completed_at
        ) ELSE NULL END, 'sandboxId', enrollment_row.sandbox_id,
      'sandboxName', enrollment_row.sandbox_name,
      'createdAt', enrollment_row.created_at, 'revokedAt', enrollment_row.revoked_at,
      'updatedAt', enrollment_row.updated_at
    ) || pg_catalog.jsonb_build_object(
      'reach', CASE WHEN enrollment_row.authority_scope = 'organization'
        THEN pg_catalog.jsonb_build_object(
          'homeWorkspaceId', enrollment_row.workspace_id,
          'allowedWorkspaceIds', pg_catalog.to_jsonb(enrollment_row.allowed_workspace_ids),
          'allowPersonalWorkspaces', enrollment_row.allow_personal_workspaces
        ) ELSE NULL END
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

CREATE OR REPLACE FUNCTION get_scoped_sandbox(p_account_id uuid, p_workspace_id uuid, p_sandbox_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE actor_membership_id uuid; result jsonb; workspace_personal boolean;
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'read')
  ON CONFLICT DO NOTHING;
  actor_membership_id := scoped_compute_actor_membership(p_account_id, p_workspace_id);
  workspace_personal := get_workspace_kind(p_account_id, p_workspace_id) = 'personal';
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
        (enrollment.authority_scope = 'organization'
          AND opengeni_private.organization_compute_reaches_v1(
            p_workspace_id, workspace_personal, enrollment.workspace_id,
            enrollment.allowed_workspace_ids, enrollment.allow_personal_workspaces))
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

CREATE OR REPLACE FUNCTION authorize_scoped_sandbox_attach(p_account_id uuid, p_workspace_id uuid, p_sandbox_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE actor_membership_id uuid; sandbox_row sandboxes%ROWTYPE;
  enrollment_row enrollments%ROWTYPE; authorized boolean := false; capability_added boolean;
  workspace_personal boolean;
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(backend_pid, transaction_id, capability_kind)
  VALUES (pg_backend_pid(), pg_current_xact_id(), 'write') ON CONFLICT DO NOTHING;
  capability_added := FOUND;
  actor_membership_id := scoped_compute_actor_membership(p_account_id, p_workspace_id);
  workspace_personal := get_workspace_kind(p_account_id, p_workspace_id) = 'personal';
  SELECT sandbox.* INTO sandbox_row FROM sandboxes sandbox
  WHERE sandbox.id = p_sandbox_id AND sandbox.account_id = p_account_id FOR SHARE;
  IF sandbox_row.id IS NOT NULL AND sandbox_row.kind <> 'selfhosted' THEN
    authorized := sandbox_row.workspace_id = p_workspace_id;
  ELSIF sandbox_row.id IS NOT NULL THEN
    SELECT enrollment.* INTO enrollment_row FROM enrollments enrollment
    WHERE enrollment.id = sandbox_row.enrollment_id AND enrollment.account_id = p_account_id
      AND enrollment.status = 'active' FOR SHARE;
    authorized := enrollment_row.id IS NOT NULL AND (
      (enrollment_row.authority_scope = 'organization'
        AND opengeni_private.organization_compute_reaches_v1(
          p_workspace_id, workspace_personal, enrollment_row.workspace_id,
          enrollment_row.allowed_workspace_ids, enrollment_row.allow_personal_workspaces))
      OR (enrollment_row.authority_scope = 'workspace' AND enrollment_row.workspace_id = p_workspace_id)
      OR (enrollment_row.authority_scope = 'user'
        AND enrollment_row.owner_organization_membership_id = actor_membership_id)
    );
  END IF;
  IF capability_added THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned() AND capability_kind = 'write';
  END IF;
  RETURN authorized;
END
$$;

CREATE OR REPLACE FUNCTION list_scoped_rigs(p_account_id uuid, p_workspace_id uuid, p_rig_id uuid DEFAULT NULL::uuid, p_name text DEFAULT NULL::text, p_scope text DEFAULT NULL::text) RETURNS SETOF jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  actor_membership_id uuid;
  rig_row record;
  workspace_personal boolean;
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'read')
  ON CONFLICT DO NOTHING;
  actor_membership_id := scoped_compute_actor_membership(p_account_id, p_workspace_id);
  workspace_personal := get_workspace_kind(p_account_id, p_workspace_id) = 'personal';
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
        (rig.authority_scope = 'organization'
          AND opengeni_private.organization_compute_reaches_v1(
            p_workspace_id, workspace_personal, rig.workspace_id,
            rig.allowed_workspace_ids, rig.allow_personal_workspaces))
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

CREATE OR REPLACE FUNCTION materialize_scoped_rig_version_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
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
    AND rig.status = 'active';
  SELECT version.* INTO STRICT version_row FROM rig_versions version
  WHERE version.id = session_row.rig_version_id AND version.rig_id = rig_row.id
    AND version.account_id = p_account_id;
  IF rig_row.authority_scope = 'workspace'
    AND rig_row.workspace_id IS DISTINCT FROM p_workspace_id
  THEN RAISE EXCEPTION 'workspace rig is outside the runtime workspace'
    USING ERRCODE = '42501';
  ELSIF rig_row.authority_scope = 'organization'
    AND NOT opengeni_private.organization_compute_reaches_v1(
      p_workspace_id, get_workspace_kind(p_account_id, p_workspace_id) = 'personal',
      rig_row.workspace_id, rig_row.allowed_workspace_ids, rig_row.allow_personal_workspaces)
  THEN RAISE EXCEPTION 'organization rig does not work in the runtime workspace'
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

CREATE OR REPLACE FUNCTION scoped_rig_json(p_rig_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
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
    'activeVersionHealth', (
      SELECT pg_catalog.jsonb_build_object(
        'checkHealth', coalesce(health.check_health, 'unknown'),
        'lastVerifiedAt', health.verified_at
      )
      FROM rig_versions active_version
      LEFT JOIN LATERAL (
        SELECT candidate.check_health, candidate.verified_at
        FROM (
          SELECT CASE change.verification ->> 'passed'
              WHEN 'true' THEN 'passing' WHEN 'false' THEN 'failing' END AS check_health,
            coalesce(
              nullif(change.verification ->> 'finishedAt', '')::timestamptz,
              change.updated_at
            ) AS verified_at
          FROM rig_changes change
          WHERE change.account_id = active_version.account_id
            AND change.workspace_id = active_version.workspace_id
            AND change.result_version_id = active_version.id
            AND change.verification ->> 'passed' IN ('true', 'false')
          UNION ALL
          SELECT CASE event.action WHEN 'rig.verification.passed' THEN 'passing'
              ELSE 'failing' END,
            event.occurred_at
          FROM audit_events event
          WHERE event.account_id = active_version.account_id
            AND event.workspace_id = active_version.workspace_id
            AND event.target_type = 'rig'
            AND event.target_id = rig.id::text
            AND event.action IN ('rig.verification.passed', 'rig.verification.failed')
            AND event.metadata ->> 'versionId' = active_version.id::text
        ) candidate
        ORDER BY candidate.verified_at DESC
        LIMIT 1
      ) health ON true
      WHERE active_version.rig_id = rig.id
        AND active_version.account_id = rig.account_id
        AND active_version.active = true
      LIMIT 1
    ),
    'versionCount', (SELECT count(*)::integer FROM rig_versions version
      WHERE version.rig_id = rig.id AND version.account_id = rig.account_id),
    'createdAt', rig.created_at, 'updatedAt', rig.updated_at
  ) || pg_catalog.jsonb_build_object(
    'reach', CASE WHEN rig.authority_scope = 'organization'
      THEN pg_catalog.jsonb_build_object(
        'homeWorkspaceId', rig.workspace_id,
        'allowedWorkspaceIds', pg_catalog.to_jsonb(rig.allowed_workspace_ids),
        'allowPersonalWorkspaces', rig.allow_personal_workspaces
      ) ELSE NULL END
  ) FROM rigs rig WHERE rig.id = p_rig_id
$$;

-- The same pinned search paths as the baseline gave these routines;
-- list_scoped_enrollments and scoped_rig_json keep FROM CURRENT, as there.
DO $search_paths$
BEGIN
  EXECUTE format('ALTER FUNCTION get_scoped_sandbox(uuid, uuid, uuid) SET search_path = %I, pg_catalog, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION authorize_scoped_sandbox_attach(uuid, uuid, uuid) SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION list_scoped_rigs(uuid, uuid, uuid, text, text) SET search_path = %I, pg_catalog, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION materialize_scoped_rig_version_for_attempt(uuid, uuid, uuid, uuid, uuid, integer) SET search_path = %I, pg_catalog, pg_temp', current_schema());
END
$search_paths$;

