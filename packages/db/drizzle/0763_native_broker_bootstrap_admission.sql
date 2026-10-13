-- deployment-mode: rolling
-- Read-only bridge from immutable creation qualification to initial-channel
-- capture. This does not enroll a group or grant command/release authority.
SET LOCAL lock_timeout = '5s';

DO $bootstrap_reader$
DECLARE target_schema text := current_schema(); routine regprocedure; role_name text;
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.native_broker_bootstrap_admission(
      p_account uuid, p_workspace uuid, p_group uuid, p_lease uuid,
      p_operation text, p_instance text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $read$
    DECLARE qualification jsonb; candidate record;
    BEGIN
      -- The existing scoped reader also validates the original human/key birth.
      qualification := %1$I.native_command_birth_qualification(p_account, p_workspace, p_group);
      IF qualification IS NULL OR NOT qualification ? 'brokerArtifact' THEN
        RAISE EXCEPTION 'Native broker bootstrap requires a broker-qualified birth' USING ERRCODE = '55000';
      END IF;
      SELECT lease.*, enrollment.create_epoch, enrollment.create_attempt AS enrolled_attempt,
        binding.instance_id AS qualified_instance, binding.warm_epoch
      INTO candidate FROM %1$I.sandbox_leases lease
      JOIN opengeni_private.native_command_provider_enrollments enrollment
        ON enrollment.data_schema = %2$L AND enrollment.account_id = p_account
        AND enrollment.workspace_id = p_workspace AND enrollment.sandbox_group_id = p_group
        AND enrollment.lease_id = lease.id AND enrollment.create_operation_id = p_operation
        AND enrollment.qualification_id::text = qualification->>'id'
      LEFT JOIN opengeni_private.native_command_provider_bindings binding
        ON binding.data_schema = enrollment.data_schema AND binding.account_id = enrollment.account_id
        AND binding.workspace_id = enrollment.workspace_id AND binding.sandbox_group_id = enrollment.sandbox_group_id
        AND binding.lease_id = enrollment.lease_id AND binding.create_operation_id = enrollment.create_operation_id
      WHERE lease.id = p_lease AND lease.account_id = p_account
        AND lease.workspace_id = p_workspace AND lease.sandbox_group_id = p_group;
      IF NOT FOUND OR candidate.backend <> 'modal'
        OR candidate.instance_id IS DISTINCT FROM p_instance OR p_instance IS NULL
        OR candidate.provider_create_attempt->>'instanceId' IS DISTINCT FROM p_instance
        OR candidate.provider_create_attempt->>'operationId' IS DISTINCT FROM p_operation
        OR (candidate.provider_create_attempt->>'leaseEpoch')::bigint IS DISTINCT FROM candidate.create_epoch
        OR (candidate.provider_create_attempt - 'instanceId') IS DISTINCT FROM (candidate.enrolled_attempt - 'instanceId')
        OR (candidate.liveness = 'warming' AND candidate.lease_epoch = candidate.create_epoch
          OR candidate.liveness = 'warm' AND candidate.lease_epoch = candidate.create_epoch + 1
            AND candidate.qualified_instance = p_instance AND candidate.warm_epoch = candidate.lease_epoch) IS NOT TRUE THEN
        RAISE EXCEPTION 'Native broker bootstrap physical creation is fenced' USING ERRCODE = '55000';
      END IF;
      RETURN jsonb_build_object('qualification', qualification,
        'plan', candidate.provider_create_attempt->'nativeBroker',
        'providerBindingKey', candidate.provider_create_attempt->'providerBindingKey',
        'createEpoch', candidate.create_epoch, 'phase', candidate.liveness);
    END
    $read$;
  $ddl$, target_schema, target_schema);
  routine := format('%I.native_broker_bootstrap_admission(uuid,uuid,uuid,uuid,text,text)', target_schema)::regprocedure;
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine);
  FOR role_name IN SELECT DISTINCT role.rolname FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    JOIN pg_roles role ON role.oid = acl.grantee WHERE p.oid = routine AND acl.grantee <> p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', routine, role_name); END LOOP;
  FOR role_name IN SELECT r.rolname FROM pg_roles r
    WHERE r.rolname = 'opengeni_app' OR r.oid IN (
      SELECT acl.grantee FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      WHERE p.oid = format('%I.native_command_birth_qualification(uuid,uuid,uuid)', target_schema)::regprocedure
        AND acl.privilege_type = 'EXECUTE' AND acl.grantee <> p.proowner
    )
  LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', routine, role_name); END LOOP;
END
$bootstrap_reader$;
