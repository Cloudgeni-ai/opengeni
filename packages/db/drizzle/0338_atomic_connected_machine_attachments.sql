-- deployment-mode: maintenance
-- Extend accepted-turn personal-resource attachments to the selected user-owned
-- Connected Machine. The attachment summary and protocol-v1 attempt snapshot
-- now admit a third resource kind, so every API/control/turn worker must be
-- stopped before this cutover and no pre-0338 worker may restart afterwards.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $atomic_connected_machine_writer_drain_before_lock$
DECLARE
  configured_roles_text text := nullif(
    current_setting('opengeni.migration_application_roles', true), ''
  );
  configured_roles jsonb;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION
      '0338 atomic Connected Machine attachment requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0338 atomic Connected Machine attachment received a malformed application database role list'
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
      '0338 atomic Connected Machine attachment received an invalid application database role list'
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
      '0338 atomic Connected Machine attachment requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$atomic_connected_machine_writer_drain_before_lock$;

LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE session_turns IN ACCESS EXCLUSIVE MODE;
LOCK TABLE session_turn_attempts IN ACCESS EXCLUSIVE MODE;
LOCK TABLE turn_personal_resource_attachment_receipts IN ACCESS EXCLUSIVE MODE;
LOCK TABLE turn_personal_resource_snapshots IN ACCESS EXCLUSIVE MODE;
LOCK TABLE session_attempt_personal_resource_snapshots IN ACCESS EXCLUSIVE MODE;
LOCK TABLE enrollments IN ACCESS EXCLUSIVE MODE;
LOCK TABLE sandboxes IN ACCESS EXCLUSIVE MODE;

DO $atomic_connected_machine_writer_drain_after_lock$
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
      '0338 atomic Connected Machine attachment requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$atomic_connected_machine_writer_drain_after_lock$;

ALTER TABLE turn_personal_resource_attachment_receipts
  DROP CONSTRAINT turn_personal_resource_attachment_receipts_identity_chk;
ALTER TABLE turn_personal_resource_attachment_receipts
  ADD CONSTRAINT turn_personal_resource_attachment_receipts_identity_chk CHECK (
    octet_length(initiating_human_subject_id) BETWEEN 1 AND 512
    AND membership_authorization_revision > 0
    AND session_authority_epoch > 0
    AND grant_mode IN ('once', 'session', 'always')
    AND session_visibility IN ('user_private', 'workspace_shared')
    AND shared_output_warning_version = 1
    AND resource_count BETWEEN 1 AND 28
    AND (session_visibility <> 'workspace_shared' OR shared_output_acknowledged IS TRUE)
  );

ALTER TABLE turn_personal_resource_snapshots
  DROP CONSTRAINT turn_personal_resource_snapshots_kind_chk;
ALTER TABLE turn_personal_resource_snapshots
  ADD CONSTRAINT turn_personal_resource_snapshots_kind_chk CHECK (
    (resource_kind = 'variable_set' AND action = 'variable_set.use'
      AND resource_version_id IS NULL)
    OR (resource_kind = 'rig' AND action = 'rig.use'
      AND resource_version_id IS NOT NULL)
    OR (resource_kind = 'connected_machine' AND action = 'connected_machine.use'
      AND resource_version_id IS NULL)
  );

ALTER TABLE session_attempt_personal_resource_snapshots
  DROP CONSTRAINT session_attempt_personal_resource_snapshots_kind_chk;
ALTER TABLE session_attempt_personal_resource_snapshots
  ADD CONSTRAINT session_attempt_personal_resource_snapshots_kind_chk CHECK (
    (resource_kind = 'variable_set' AND resource_version_id IS NULL)
    OR (resource_kind = 'rig' AND resource_version_id IS NOT NULL)
    OR (resource_kind = 'connected_machine' AND resource_version_id IS NULL)
  );
ALTER TABLE session_attempt_personal_resource_snapshots
  DROP CONSTRAINT session_attempt_personal_resource_snapshots_action_chk;
ALTER TABLE session_attempt_personal_resource_snapshots
  ADD CONSTRAINT session_attempt_personal_resource_snapshots_action_chk CHECK (
    (resource_kind = 'variable_set' AND action = 'variable_set.use')
    OR (resource_kind = 'rig' AND action = 'rig.use')
    OR (resource_kind = 'connected_machine' AND action = 'connected_machine.use')
  );

-- The source-patch block contains the replacement function's enrollment and
-- sandbox reads. The production migrator is a NON-superuser/NOBYPASSRLS owner,
-- so make those references owner-visible inside this exact transaction-local
-- window. A failure rolls the complete migration back, including FORCE state.
ALTER TABLE enrollments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sandboxes NO FORCE ROW LEVEL SECURITY;

-- The 0306 function is long and security-sensitive. Patch only its four exact,
-- previously shipped source fragments and abort if any expected fragment is
-- absent. Recreating the signature explicitly preserves the hardened search
-- path while keeping this migration reviewable as a narrow protocol extension.
DO $extend_atomic_attachment_function$
DECLARE
  data_schema text := current_schema();
  function_source text;
  prior_source text;
BEGIN
  SELECT procedure_value.prosrc INTO STRICT function_source
  FROM pg_proc procedure_value
  JOIN pg_namespace namespace_value ON namespace_value.oid = procedure_value.pronamespace
  WHERE namespace_value.nspname = data_schema
    AND procedure_value.oid = (
      pg_catalog.format(
        '%I.accept_turn_personal_resource_attachment(uuid,uuid,uuid,uuid,text,integer,boolean,integer)',
        data_schema
      )::regprocedure
    );

  prior_source := function_source;
  function_source := replace(function_source,
    $old$  FOR SHARE OF variable_set;

  WITH selected AS ($old$,
    $new$  FOR SHARE OF variable_set;
  PERFORM sandbox.id
  FROM sandboxes sandbox
  WHERE sandbox.id = session_row.active_sandbox_id
    AND sandbox.account_id = p_account_id
    AND sandbox.kind = 'selfhosted'
  FOR SHARE;
  PERFORM enrollment.id
  FROM sandboxes sandbox
  JOIN enrollments enrollment
    ON enrollment.id = sandbox.enrollment_id
   AND enrollment.account_id = p_account_id
  WHERE sandbox.id = session_row.active_sandbox_id
    AND sandbox.account_id = p_account_id
    AND sandbox.kind = 'selfhosted'
    AND enrollment.authority_scope = 'user'
  FOR SHARE OF enrollment;

  WITH selected AS ($new$
  );
  IF function_source = prior_source THEN
    RAISE EXCEPTION '0338 could not extend the atomic attachment lock set'
      USING ERRCODE = '55000';
  END IF;

  prior_source := function_source;
  function_source := replace(function_source,
    $old$    WHERE version_value.id = session_row.rig_version_id
      AND version_value.rig_id = session_row.rig_id
      AND version_value.account_id = p_account_id
  ), grouped AS ($old$,
    $new$    WHERE version_value.id = session_row.rig_version_id
      AND version_value.rig_id = session_row.rig_id
      AND version_value.account_id = p_account_id
    UNION ALL
    SELECT 'connected_machine', enrollment.id, NULL::uuid,
      'connected_machine.use', 'session_active_sandbox',
      enrollment.origin_workspace_id, enrollment.authority_id,
      enrollment.owner_organization_membership_id
    FROM sandboxes sandbox
    JOIN enrollments enrollment
      ON enrollment.id = sandbox.enrollment_id
     AND enrollment.account_id = p_account_id
    WHERE sandbox.id = session_row.active_sandbox_id
      AND sandbox.account_id = p_account_id
      AND sandbox.kind = 'selfhosted'
      AND enrollment.authority_scope = 'user'
      AND enrollment.status = 'active'
  ), grouped AS ($new$
  );
  IF function_source = prior_source THEN
    RAISE EXCEPTION '0338 could not extend the atomic attachment closure'
      USING ERRCODE = '55000';
  END IF;

  prior_source := function_source;
  function_source := replace(
    function_source,
    'no personal Variable Set or Rig is selected by this session',
    'no personal Variable Set, Rig, or Connected Machine is selected by this session'
  );
  IF function_source = prior_source THEN
    RAISE EXCEPTION '0338 could not update the empty attachment diagnostic'
      USING ERRCODE = '55000';
  END IF;
  function_source := replace(
    function_source,
    'personal Variable Set/Rig closure exceeds the accepted-work bound',
    'personal resource closure exceeds the accepted-work bound'
  );
  function_source := replace(function_source, 'IF selected_count > 27 THEN',
    'IF selected_count > 28 THEN');
  IF function_source NOT LIKE '%IF selected_count > 28 THEN%'
    OR function_source LIKE '%IF selected_count > 27 THEN%'
  THEN
    RAISE EXCEPTION '0338 could not update the attachment bound'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE pg_catalog.format(
    'CREATE OR REPLACE FUNCTION %I.accept_turn_personal_resource_attachment('
      || 'p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, '
      || 'p_mode text, p_expected_authority_epoch integer, '
      || 'p_workspace_shared_acknowledged boolean, '
      || 'p_shared_output_warning_version integer) '
      || 'RETURNS TABLE (grant_mode text, grant_context text, resource_count integer, '
      || 'resource_kinds text[], shared_output_warning_version integer, replay boolean) '
      || 'LANGUAGE plpgsql SECURITY DEFINER '
      || 'SET search_path TO pg_catalog, %I, pg_temp AS %L',
    data_schema, data_schema, function_source
  );
END
$extend_atomic_attachment_function$;

ALTER TABLE enrollments FORCE ROW LEVEL SECURITY;
ALTER TABLE sandboxes FORCE ROW LEVEL SECURITY;

-- Protocol-v1 attachment admission runs before this alphabetically-later
-- trigger and has already validated/copy-frozen the complete accepted-turn
-- snapshot. Reuse that exact machine row, including a consumed `once` grant,
-- instead of selecting mutable grant state again. Version-0 turns keep the
-- pre-0338 trigger unchanged.
CREATE FUNCTION admit_session_attempt_personal_machine_v1() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  session_row sessions%ROWTYPE;
  sandbox_row sandboxes%ROWTYPE;
  enrollment_row enrollments%ROWTYPE;
  snapshot_row session_attempt_personal_resource_snapshots%ROWTYPE;
BEGIN
  INSERT INTO opengeni_private.scoped_compute_capabilities(
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'write')
  ON CONFLICT DO NOTHING;

  SELECT session_value.* INTO STRICT session_row
  FROM sessions session_value
  WHERE session_value.id = NEW.session_id
    AND session_value.account_id = NEW.account_id
    AND session_value.workspace_id = NEW.workspace_id
  FOR SHARE;
  IF session_row.active_sandbox_id IS NULL THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
    RETURN NEW;
  END IF;

  SELECT sandbox.* INTO sandbox_row
  FROM sandboxes sandbox
  WHERE sandbox.id = session_row.active_sandbox_id
    AND sandbox.account_id = NEW.account_id
    AND sandbox.kind = 'selfhosted'
  FOR SHARE;
  IF sandbox_row.enrollment_id IS NULL THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
    RETURN NEW;
  END IF;

  SELECT enrollment.* INTO enrollment_row
  FROM enrollments enrollment
  WHERE enrollment.id = sandbox_row.enrollment_id
    AND enrollment.account_id = NEW.account_id
    AND enrollment.authority_scope = 'user'
    AND enrollment.status = 'active'
  FOR SHARE;
  IF enrollment_row.id IS NULL THEN
    DELETE FROM opengeni_private.scoped_compute_capabilities
    WHERE backend_pid = pg_catalog.pg_backend_pid()
      AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
    RETURN NEW;
  END IF;

  SELECT snapshot.* INTO STRICT snapshot_row
  FROM session_attempt_personal_resource_snapshots snapshot
  WHERE snapshot.attempt_id = NEW.id
    AND snapshot.account_id = NEW.account_id
    AND snapshot.workspace_id = NEW.workspace_id
    AND snapshot.session_id = NEW.session_id
    AND snapshot.turn_id = NEW.turn_id
    AND snapshot.execution_generation = NEW.execution_generation
    AND snapshot.resource_kind = 'connected_machine'
    AND snapshot.resource_id = enrollment_row.id
    AND snapshot.action = 'connected_machine.use';

  IF snapshot_row.authority_id IS DISTINCT FROM enrollment_row.authority_id
    OR snapshot_row.authority_generation IS DISTINCT FROM enrollment_row.generation
    OR snapshot_row.owner_organization_membership_id
      IS DISTINCT FROM enrollment_row.owner_organization_membership_id
    OR snapshot_row.session_visibility IS DISTINCT FROM session_row.visibility
    OR snapshot_row.session_authority_epoch IS DISTINCT FROM session_row.authority_epoch
  THEN
    RAISE EXCEPTION 'turn-bound personal machine snapshot is not current'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO session_attempt_connected_machine_authorizations(
    attempt_id, account_id, workspace_id, session_id, turn_id, execution_generation,
    initiating_human_subject_id, owner_organization_membership_id,
    membership_authorization_revision, enrollment_id, sandbox_id, authority_id,
    authority_generation, enrollment_generation, session_visibility,
    session_authority_epoch, grant_id, grant_generation, grant_mode
  )
  SELECT NEW.id, NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id,
    NEW.execution_generation, admission.initiating_human_subject_id,
    snapshot_row.owner_organization_membership_id,
    snapshot_row.membership_authorization_revision, enrollment_row.id, sandbox_row.id,
    snapshot_row.authority_id, snapshot_row.authority_generation,
    enrollment_row.generation, snapshot_row.session_visibility,
    snapshot_row.session_authority_epoch, snapshot_row.grant_id,
    snapshot_row.grant_generation, snapshot_row.grant_mode
  FROM session_attempt_personal_resource_admissions admission
  WHERE admission.attempt_id = NEW.id
    AND admission.account_id = NEW.account_id
    AND admission.workspace_id = NEW.workspace_id
    AND admission.session_id = NEW.session_id
    AND admission.turn_id = NEW.turn_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'turn-bound personal machine admission is missing'
      USING ERRCODE = '42501';
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
$body$;

DROP TRIGGER z_session_attempt_personal_machine_admission ON session_turn_attempts;
CREATE TRIGGER z_session_attempt_personal_machine_admission_legacy
AFTER INSERT ON session_turn_attempts FOR EACH ROW
WHEN (NEW.personal_resource_protocol_version = 0)
EXECUTE FUNCTION admit_session_attempt_personal_machine();
CREATE TRIGGER zz_session_attempt_personal_machine_admission_v1
AFTER INSERT ON session_turn_attempts FOR EACH ROW
WHEN (NEW.personal_resource_protocol_version = 1)
EXECUTE FUNCTION admit_session_attempt_personal_machine_v1();

REVOKE ALL ON FUNCTION admit_session_attempt_personal_machine_v1() FROM PUBLIC;

DO $atomic_connected_machine_function_hardening$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.admit_session_attempt_personal_machine_v1() '
      || 'SET search_path TO pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
END
$atomic_connected_machine_function_hardening$;
