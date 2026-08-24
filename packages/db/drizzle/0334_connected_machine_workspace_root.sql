-- deployment-mode: rolling

ALTER TABLE "enrollments"
ADD COLUMN "workspace_root" text;

ALTER TABLE "enrollments"
ADD CONSTRAINT "enrollments_workspace_root_shape"
CHECK (
  "workspace_root" IS NULL
  OR (
    length("workspace_root") BETWEEN 1 AND 4096
  )
);

-- Scoped machine reads return an explicit JSON contract rather than row_to_json,
-- so the new root must be projected here as well. This preserves organization,
-- workspace, and user-private machine authority without a second unscoped read.
CREATE OR REPLACE FUNCTION list_scoped_enrollments(
  p_account_id uuid, p_workspace_id uuid, p_enrollment_id uuid DEFAULT NULL,
  p_status text DEFAULT 'active'
) RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
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
      'workspaceRoot', enrollment_row.workspace_root,
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