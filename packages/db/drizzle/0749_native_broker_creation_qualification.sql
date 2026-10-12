-- deployment-mode: maintenance
-- Distinct broker qualification; never reinterpret a router qualification or
-- enroll existing groups. Drain old binaries before selecting this protocol.
SET LOCAL lock_timeout = '5s';

ALTER TABLE opengeni_private.native_command_qualifications
  ADD COLUMN broker_artifact jsonb,
  DROP CONSTRAINT native_command_qualifications_protocols_check;
ALTER TABLE opengeni_private.native_command_qualifications
  ADD CONSTRAINT native_command_qualifications_protocols_check CHECK (
    (protocols = ARRAY['native-subreaper-v1','native-subreaper-pty-v1']
      AND broker_artifact IS NULL)
    OR (protocols = ARRAY['native-subreaper-broker-channel-v1','native-subreaper-broker-channel-pty-v1']
      AND (jsonb_typeof(broker_artifact) = 'object'
        AND broker_artifact = jsonb_build_object(
          'artifactSha256', broker_artifact->'artifactSha256',
          'byteSize', broker_artifact->'byteSize', 'target', broker_artifact->'target')
        AND jsonb_typeof(broker_artifact->'artifactSha256') = 'string'
        AND broker_artifact->>'artifactSha256' ~ '^[a-f0-9]{64}$'
        AND jsonb_typeof(broker_artifact->'byteSize') = 'number'
        AND CASE WHEN broker_artifact->>'byteSize' ~ '^[0-9]{2,6}$'
          THEN (broker_artifact->>'byteSize')::integer BETWEEN 64 AND 262144 ELSE false END
        AND broker_artifact->>'target' IN ('linux-amd64','linux-arm64')) IS TRUE)
  );

-- Physical broker identities cannot be carried into another create operation,
-- including a later epoch of the same logical group. Existing rows stay intact.
CREATE UNIQUE INDEX native_command_broker_physical_identity
  ON opengeni_private.native_command_provider_enrollments
    (data_schema, workspace_id, (create_attempt #>> '{nativeBroker,brokerId}'))
  WHERE create_attempt ? 'nativeBroker';

DO $broker_contract$
DECLARE target_schema text := current_schema(); routine regprocedure; role_name text;
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.guard_native_broker_create() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $guard$
    DECLARE qualification opengeni_private.native_command_qualifications%%ROWTYPE;
      attempt jsonb := NEW.provider_create_attempt;
      plan jsonb := attempt->'nativeBroker';
    BEGIN
      SELECT q.* INTO qualification FROM opengeni_private.native_command_group_births birth
        JOIN opengeni_private.native_command_qualifications q
          ON q.data_schema = birth.data_schema AND q.workspace_id = birth.workspace_id
          AND q.id = birth.qualification_id
        WHERE birth.data_schema = %2$L AND birth.workspace_id = NEW.workspace_id
          AND birth.sandbox_group_id = NEW.sandbox_group_id;
      IF NOT FOUND OR qualification.broker_artifact IS NULL THEN
        IF attempt ? 'nativeBroker' THEN
          RAISE EXCEPTION 'Native broker creation requires a broker-qualified group birth' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END IF;
      -- An unbound warming lease precedes admission; it has no create yet.
      -- The original enrollment trigger still requires an attempt at WARM.
      IF attempt IS NULL THEN RETURN NEW; END IF;
      IF NOT (plan = jsonb_build_object('version', 1, 'brokerId', plan->'brokerId',
          'sourceSha', qualification.source_sha, 'imageId', qualification.provider_image_id,
          'artifact', qualification.broker_artifact)
        AND jsonb_typeof(plan->'brokerId') = 'string'
        AND plan->>'brokerId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        AND attempt->>'imageId' = qualification.provider_image_id
        AND attempt->'nativeImageSource' = jsonb_build_object('kind', 'stock-registry',
          'imageId', qualification.provider_image_id, 'checkpointArtifactId', NULL)) IS TRUE THEN
        RAISE EXCEPTION 'Native broker create plan or image differs from its exact qualification' USING ERRCODE = '55000';
      END IF;
      -- Later capture/drain must preserve the original plan and may create a
      -- snapshot. Only a fresh dispatch is blocked from consuming that snapshot.
      IF attempt IS DISTINCT FROM OLD.provider_create_attempt
        AND attempt->'instanceId' = 'null'::jsonb
        AND NEW.resume_state #>> '{opengeniRecovery,archive,current,provider}'
          IN ('modal_snapshot_filesystem','modal_snapshot_directory') THEN
        RAISE EXCEPTION 'Native broker snapshot creation requires separate preservation qualification' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END
    $guard$;
    CREATE TRIGGER guard_native_broker_create BEFORE UPDATE OF provider_create_attempt, liveness
      ON %1$I.sandbox_leases FOR EACH ROW EXECUTE FUNCTION %1$I.guard_native_broker_create();

    CREATE OR REPLACE FUNCTION %1$I.native_command_birth_qualification(p_account uuid, p_workspace uuid, p_group uuid)
    RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $read$
    DECLARE birth opengeni_private.native_command_group_births%%ROWTYPE;
      q opengeni_private.native_command_qualifications%%ROWTYPE;
    BEGIN
      IF p_account::text IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')
        OR p_workspace::text IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '') THEN
        RAISE EXCEPTION 'Native command qualification scope mismatch' USING ERRCODE = '42501';
      END IF;
      SELECT * INTO birth FROM opengeni_private.native_command_group_births b
        WHERE b.data_schema = %2$L AND b.workspace_id = p_workspace AND b.sandbox_group_id = p_group;
      IF NOT FOUND THEN RETURN NULL; END IF;
      SELECT * INTO STRICT q FROM opengeni_private.native_command_qualifications qualification
        WHERE qualification.data_schema = birth.data_schema AND qualification.workspace_id = birth.workspace_id
          AND qualification.id = birth.qualification_id;
      IF birth.account_id IS DISTINCT FROM p_account OR birth.account_id IS DISTINCT FROM q.account_id
        OR birth.creator_kind IS DISTINCT FROM 'subject' OR birth.creator_kind IS DISTINCT FROM q.creator_kind
        OR birth.creator_subject_id IS DISTINCT FROM q.creator_subject_id
        OR birth.create_idempotency_key IS DISTINCT FROM q.create_idempotency_key THEN
        RAISE EXCEPTION 'Qualified native command birth selector is inconsistent' USING ERRCODE = '55000';
      END IF;
      RETURN jsonb_build_object('id', q.id, 'accountId', q.account_id, 'workspaceId', q.workspace_id,
        'creatorSubjectId', q.creator_subject_id, 'createIdempotencyKey', q.create_idempotency_key,
        'activationGeneration', q.activation_generation, 'sourceSha', q.source_sha, 'imageRef', q.image_ref,
        'providerImageId', q.provider_image_id, 'providerBindingKey', q.provider_binding_key,
        'protocols', q.protocols, 'acceptanceEvidenceHash', q.acceptance_evidence_hash)
        || CASE WHEN q.broker_artifact IS NULL THEN '{}'::jsonb
          ELSE jsonb_build_object('brokerArtifact', q.broker_artifact) END;
    END
    $read$;
  $ddl$, target_schema, target_schema);
  -- CREATE OR REPLACE preserves the scoped reader's existing ACL. The new
  -- trigger has no callable runtime surface, even under hostile defaults.
  routine := format('%I.guard_native_broker_create()', target_schema)::regprocedure;
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine);
  FOR role_name IN SELECT DISTINCT role.rolname FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    JOIN pg_roles role ON role.oid = acl.grantee WHERE p.oid = routine AND acl.grantee <> p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', routine, role_name); END LOOP;
END
$broker_contract$;
