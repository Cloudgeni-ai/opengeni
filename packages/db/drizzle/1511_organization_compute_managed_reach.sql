-- deployment-mode: rolling
-- "All product-managed workspaces": an organization machine or sandbox
-- environment (rig) can work in every workspace the organization's product
-- manages (organization_managed_workspaces, including workspaces created
-- later and the Console test workspace) without listing their ids. Console
-- agents (organization agents) that run on an organization machine or
-- environment need this: their chats run in those workspaces.
--
-- Reach (1190) becomes: the home workspace; members' Personal workspaces when
-- allow_personal_workspaces is on; a managed workspace when the new
-- allow_managed_workspaces is on; and a shared workspace when
-- allowed_workspace_ids is NULL or lists it. The switches only add places,
-- so every existing row (allow_managed_workspaces defaults to false) keeps
-- exactly the reach it has. Managed workspaces are shared workspaces, so
-- allowed_workspace_ids NULL already includes them; the switch matters with
-- a list (or none). The one exception is the Console test workspace
-- (source 'console_test', new in 1504): only allow_managed_workspaces
-- reaches it, never "all shared workspaces" or a list, so an organization
-- machine opens to Console Editors' test chats only when an admin chose
-- managed workspaces. No such workspace exists before this release.
--
-- The functions 1190 changed are replaced with the same signatures and only
-- this added: list_scoped_enrollments, get_scoped_sandbox,
-- authorize_scoped_sandbox_attach, list_scoped_rigs and
-- materialize_scoped_rig_version_for_attempt look up whether the workspace is
-- managed (every caller is in that workspace's RLS context, which the
-- FORCE-RLS organization_managed_workspaces policy admits) and ask
-- organization_compute_reaches_v2. list_scoped_enrollments, scoped_rig_json
-- and list_organization_compute_v1 (1224) also report
-- `allowManagedWorkspaces` in `reach`. Bodies are otherwise copied unchanged
-- from 1190 and 1224, which are their latest definitions.
--
-- No new SECURITY DEFINER function: organization_compute_reaches_v2 is a pure
-- SQL helper (SECURITY INVOKER, no table access, no PUBLIC EXECUTE) that only
-- the definers call as their owner. CREATE OR REPLACE keeps the definers'
-- owners and grants; the search paths are pinned again below, as 1190 and
-- 1224 did. organization_compute_reaches_v1 stays for the previous release's
-- readers of this migration's history; nothing calls it anymore.
--
-- Rolling: adding a column with a constant default rewrites nothing. The
-- previous release never sets the new column (its reach updates leave it as
-- it is), ignores the extra `reach` key, and through these definers sees
-- the same reach for every row it can write. No CHECK is widened.
--
-- agent_revisions.runs_on_target: the organization machine or sandbox
-- environment an organization agent version's Runs on named when the version
-- was saved, by id ({"machineId"} or {"environmentId"}). Chats use it, so a
-- later rename or a second machine with the same name can't move or break the
-- agent; `config.runsOn` keeps what was written (display, config hash).
-- Nullable without a default: nothing is rewritten, the previous release
-- never writes it (its rows resolve by name, as before), and the existing
-- SELECT/INSERT grants on agent_revisions cover the new column.
--
-- organization_managed_workspaces writes need an account-only context. The
-- marker now decides machine and rig reach (above), organization agents and
-- stored end-user logins, so runtime code in one workspace's context must not
-- be able to mark (or unmark) that workspace. Restrictive INSERT, UPDATE and
-- DELETE policies add "no opengeni.workspace_id" to the existing
-- account_isolation policy; reads are unchanged. Every writer, in this and
-- the previous release, already runs in an account-only context: Console's
-- mark/unmark (setConsoleWorkspaceKind), a workspace an organization API key
-- creates (markWorkspaceManagedByApiKey) and the Console test workspace
-- (ensureOrgAgentTestWorkspace) all write through withAccountRls. Deleting a
-- workspace still removes its marker: foreign-key cascades don't apply row
-- security. A later migration that writes markers must clear
-- opengeni.workspace_id first. No SECURITY DEFINER function is added.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE enrollments
  ADD COLUMN allow_managed_workspaces boolean NOT NULL DEFAULT false;

ALTER TABLE rigs
  ADD COLUMN allow_managed_workspaces boolean NOT NULL DEFAULT false;

ALTER TABLE agent_revisions ADD COLUMN runs_on_target jsonb;
COMMENT ON COLUMN agent_revisions.runs_on_target IS 'The organization machine (machineId) or sandbox environment (environmentId) an organization agent version''s Runs on resolved to when saved; NULL otherwise.';

CREATE POLICY account_only_insert ON organization_managed_workspaces AS RESTRICTIVE
  FOR INSERT WITH CHECK (opengeni_private.current_workspace_id() IS NULL);
CREATE POLICY account_only_update ON organization_managed_workspaces AS RESTRICTIVE
  FOR UPDATE USING (opengeni_private.current_workspace_id() IS NULL)
  WITH CHECK (opengeni_private.current_workspace_id() IS NULL);
CREATE POLICY account_only_delete ON organization_managed_workspaces AS RESTRICTIVE
  FOR DELETE USING (opengeni_private.current_workspace_id() IS NULL);

-- Whether an organization machine or rig works in a workspace: always where
-- it lives, in a Personal workspace when the Personal switch is on, in the
-- Console test workspace only when the managed switch is on (never through
-- "all shared workspaces" or a list), in another managed workspace when the
-- managed switch is on, and in a shared workspace when it works in all of
-- them or that one is listed.
CREATE FUNCTION opengeni_private.organization_compute_reaches_v2(
  p_workspace_id uuid, p_workspace_personal boolean, p_workspace_managed boolean,
  p_workspace_console_test boolean,
  p_home_workspace_id uuid, p_allowed_workspace_ids uuid[],
  p_allow_personal_workspaces boolean, p_allow_managed_workspaces boolean
) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path = pg_catalog, pg_temp
    AS $$
  SELECT CASE
    WHEN p_workspace_id IS NULL THEN false
    WHEN p_workspace_id = p_home_workspace_id THEN true
    WHEN p_workspace_personal THEN coalesce(p_allow_personal_workspaces, false)
    WHEN coalesce(p_workspace_console_test, false)
      THEN coalesce(p_allow_managed_workspaces, false)
    WHEN coalesce(p_workspace_managed, false)
      AND coalesce(p_allow_managed_workspaces, false) THEN true
    ELSE p_allowed_workspace_ids IS NULL OR p_workspace_id = ANY (p_allowed_workspace_ids)
  END
$$;
REVOKE ALL ON FUNCTION opengeni_private.organization_compute_reaches_v2(uuid, boolean, boolean, boolean, uuid, uuid[], boolean, boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION list_scoped_enrollments(p_account_id uuid, p_workspace_id uuid, p_enrollment_id uuid DEFAULT NULL::uuid, p_status text DEFAULT 'active'::text) RETURNS SETOF jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE actor_membership_id uuid; enrollment_row record; workspace_personal boolean;
  workspace_managed boolean; workspace_console_test boolean;
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'read')
  ON CONFLICT DO NOTHING;
  actor_membership_id := scoped_compute_actor_membership(p_account_id, p_workspace_id);
  workspace_personal := get_workspace_kind(p_account_id, p_workspace_id) = 'personal';
  workspace_managed := EXISTS (
    SELECT 1 FROM organization_managed_workspaces managed
    WHERE managed.account_id = p_account_id AND managed.workspace_id = p_workspace_id
  );
  workspace_console_test := EXISTS (
    SELECT 1 FROM organization_managed_workspaces managed
    WHERE managed.account_id = p_account_id AND managed.workspace_id = p_workspace_id
      AND managed.source = 'console_test'
  );
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
          AND opengeni_private.organization_compute_reaches_v2(
            p_workspace_id, workspace_personal, workspace_managed, workspace_console_test,
            enrollment.workspace_id,
            enrollment.allowed_workspace_ids, enrollment.allow_personal_workspaces,
            enrollment.allow_managed_workspaces))
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
          'allowPersonalWorkspaces', enrollment_row.allow_personal_workspaces,
          'allowManagedWorkspaces', enrollment_row.allow_managed_workspaces
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
  workspace_managed boolean; workspace_console_test boolean;
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'read')
  ON CONFLICT DO NOTHING;
  actor_membership_id := scoped_compute_actor_membership(p_account_id, p_workspace_id);
  workspace_personal := get_workspace_kind(p_account_id, p_workspace_id) = 'personal';
  workspace_managed := EXISTS (
    SELECT 1 FROM organization_managed_workspaces managed
    WHERE managed.account_id = p_account_id AND managed.workspace_id = p_workspace_id
  );
  workspace_console_test := EXISTS (
    SELECT 1 FROM organization_managed_workspaces managed
    WHERE managed.account_id = p_account_id AND managed.workspace_id = p_workspace_id
      AND managed.source = 'console_test'
  );
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
          AND opengeni_private.organization_compute_reaches_v2(
            p_workspace_id, workspace_personal, workspace_managed, workspace_console_test,
            enrollment.workspace_id,
            enrollment.allowed_workspace_ids, enrollment.allow_personal_workspaces,
            enrollment.allow_managed_workspaces))
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
  workspace_personal boolean; workspace_managed boolean; workspace_console_test boolean;
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(backend_pid, transaction_id, capability_kind)
  VALUES (pg_backend_pid(), pg_current_xact_id(), 'write') ON CONFLICT DO NOTHING;
  capability_added := FOUND;
  actor_membership_id := scoped_compute_actor_membership(p_account_id, p_workspace_id);
  workspace_personal := get_workspace_kind(p_account_id, p_workspace_id) = 'personal';
  workspace_managed := EXISTS (
    SELECT 1 FROM organization_managed_workspaces managed
    WHERE managed.account_id = p_account_id AND managed.workspace_id = p_workspace_id
  );
  workspace_console_test := EXISTS (
    SELECT 1 FROM organization_managed_workspaces managed
    WHERE managed.account_id = p_account_id AND managed.workspace_id = p_workspace_id
      AND managed.source = 'console_test'
  );
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
        AND opengeni_private.organization_compute_reaches_v2(
          p_workspace_id, workspace_personal, workspace_managed, workspace_console_test,
            enrollment_row.workspace_id,
          enrollment_row.allowed_workspace_ids, enrollment_row.allow_personal_workspaces,
          enrollment_row.allow_managed_workspaces))
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
  workspace_managed boolean; workspace_console_test boolean;
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'read')
  ON CONFLICT DO NOTHING;
  actor_membership_id := scoped_compute_actor_membership(p_account_id, p_workspace_id);
  workspace_personal := get_workspace_kind(p_account_id, p_workspace_id) = 'personal';
  workspace_managed := EXISTS (
    SELECT 1 FROM organization_managed_workspaces managed
    WHERE managed.account_id = p_account_id AND managed.workspace_id = p_workspace_id
  );
  workspace_console_test := EXISTS (
    SELECT 1 FROM organization_managed_workspaces managed
    WHERE managed.account_id = p_account_id AND managed.workspace_id = p_workspace_id
      AND managed.source = 'console_test'
  );
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
          AND opengeni_private.organization_compute_reaches_v2(
            p_workspace_id, workspace_personal, workspace_managed, workspace_console_test,
            rig.workspace_id,
            rig.allowed_workspace_ids, rig.allow_personal_workspaces,
            rig.allow_managed_workspaces))
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
    AND NOT opengeni_private.organization_compute_reaches_v2(
      p_workspace_id, get_workspace_kind(p_account_id, p_workspace_id) = 'personal',
      EXISTS (
        SELECT 1 FROM organization_managed_workspaces managed
        WHERE managed.account_id = p_account_id AND managed.workspace_id = p_workspace_id
      ),
      EXISTS (
        SELECT 1 FROM organization_managed_workspaces managed
        WHERE managed.account_id = p_account_id AND managed.workspace_id = p_workspace_id
          AND managed.source = 'console_test'
      ),
      rig_row.workspace_id, rig_row.allowed_workspace_ids, rig_row.allow_personal_workspaces,
      rig_row.allow_managed_workspaces)
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
        'allowPersonalWorkspaces', rig.allow_personal_workspaces,
        'allowManagedWorkspaces', rig.allow_managed_workspaces
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


-- list_organization_compute_v1 (1224): the same, reporting the managed switch.
CREATE OR REPLACE FUNCTION opengeni_private.list_organization_compute_v1(
  p_account_id uuid, p_workspace_id uuid, p_kind text
) RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $organization_compute$
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('machine', 'rig') THEN
    RAISE EXCEPTION 'invalid organization compute kind' USING ERRCODE = '22023';
  END IF;
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'read')
  ON CONFLICT DO NOTHING;
  PERFORM scoped_compute_actor_membership(p_account_id, p_workspace_id);
  IF p_kind = 'machine' THEN
    RETURN QUERY
      SELECT pg_catalog.jsonb_build_object(
        'id', enrollment.id,
        'sandboxId', sandbox.id,
        'sandboxName', sandbox.name,
        'os', enrollment.os,
        'reach', pg_catalog.jsonb_build_object(
          'homeWorkspaceId', enrollment.workspace_id,
          'allowedWorkspaceIds', pg_catalog.to_jsonb(enrollment.allowed_workspace_ids),
          'allowPersonalWorkspaces', enrollment.allow_personal_workspaces,
          'allowManagedWorkspaces', enrollment.allow_managed_workspaces
        )
      )
      FROM enrollments enrollment
      LEFT JOIN LATERAL (
        SELECT value.id, value.name FROM sandboxes value
        WHERE value.enrollment_id = enrollment.id AND value.account_id = enrollment.account_id
        ORDER BY value.created_at LIMIT 1
      ) sandbox ON true
      WHERE enrollment.account_id = p_account_id AND enrollment.status = 'active'
        AND enrollment.kind = 'machine' AND enrollment.authority_scope = 'organization'
      ORDER BY enrollment.created_at DESC, enrollment.id;
  ELSE
    RETURN QUERY
      SELECT pg_catalog.jsonb_build_object(
        'id', rig.id,
        'name', rig.name,
        'reach', pg_catalog.jsonb_build_object(
          'homeWorkspaceId', rig.workspace_id,
          'allowedWorkspaceIds', pg_catalog.to_jsonb(rig.allowed_workspace_ids),
          'allowPersonalWorkspaces', rig.allow_personal_workspaces,
          'allowManagedWorkspaces', rig.allow_managed_workspaces
        )
      )
      FROM rigs rig
      WHERE rig.account_id = p_account_id AND rig.status = 'active'
        AND rig.authority_scope = 'organization'
      ORDER BY rig.created_at, rig.id;
  END IF;
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
$organization_compute$;

DO $organization_compute_search_path$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.list_organization_compute_v1(uuid, uuid, text) SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    current_schema()
  );
END $organization_compute_search_path$;
