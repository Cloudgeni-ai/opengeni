-- deployment-mode: maintenance
-- Operator-qualified NEW Modal self-groups only. No timestamps, metadata,
-- existing groups, warm boxes or restored snapshots can mint birth authority.
SET LOCAL lock_timeout = '5s';

CREATE TABLE opengeni_private.native_command_qualifications (
  data_schema text NOT NULL,
  id uuid NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  creator_kind text NOT NULL DEFAULT 'subject' CHECK (creator_kind = 'subject'),
  creator_subject_id text NOT NULL CHECK (length(creator_subject_id) > 0),
  create_idempotency_key text NOT NULL CHECK (length(create_idempotency_key) BETWEEN 1 AND 200),
  activation_generation bigint NOT NULL CHECK (activation_generation > 0),
  source_sha text NOT NULL CHECK (source_sha ~ '^[a-f0-9]{40}$'),
  image_ref text NOT NULL CHECK (image_ref ~ '^(ghcr\.io/cloudgeni-ai|opengenipublicneuacr\.azurecr\.io)/opengeni-desktop@sha256:[a-f0-9]{64}$'),
  provider_image_id text NOT NULL CHECK (provider_image_id ~ '^im-[A-Za-z0-9_-]{1,200}$'),
  provider_binding_key text NOT NULL CHECK (octet_length(provider_binding_key) BETWEEN 1 AND 1024),
  protocols text[] NOT NULL CHECK (protocols = ARRAY['native-subreaper-v1', 'native-subreaper-pty-v1']),
  acceptance_evidence_hash text NOT NULL CHECK (acceptance_evidence_hash ~ '^[a-f0-9]{64}$'),
  enrollment_enabled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (data_schema, workspace_id, id),
  UNIQUE (data_schema, workspace_id, activation_generation),
  UNIQUE (data_schema, workspace_id, id, account_id, creator_kind, creator_subject_id, create_idempotency_key)
);
CREATE UNIQUE INDEX native_command_one_enabled_qualification
  ON opengeni_private.native_command_qualifications(data_schema, workspace_id)
  WHERE enrollment_enabled;

CREATE TABLE opengeni_private.native_command_group_births (
  data_schema text NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  sandbox_group_id uuid NOT NULL,
  qualification_id uuid NOT NULL,
  creator_kind text NOT NULL CHECK (creator_kind = 'subject'),
  creator_subject_id text NOT NULL CHECK (length(creator_subject_id) > 0),
  create_idempotency_key text NOT NULL CHECK (length(create_idempotency_key) BETWEEN 1 AND 200),
  PRIMARY KEY (data_schema, workspace_id, sandbox_group_id),
  FOREIGN KEY (data_schema, workspace_id, qualification_id, account_id, creator_kind, creator_subject_id, create_idempotency_key)
    REFERENCES opengeni_private.native_command_qualifications(data_schema, workspace_id, id, account_id, creator_kind, creator_subject_id, create_idempotency_key)
);

CREATE TABLE opengeni_private.native_command_provider_enrollments (
  data_schema text NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  sandbox_group_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  create_operation_id text NOT NULL,
  create_epoch bigint NOT NULL CHECK (create_epoch >= 0),
  qualification_id uuid NOT NULL,
  create_attempt jsonb NOT NULL,
  PRIMARY KEY (data_schema, workspace_id, lease_id, create_operation_id),
  UNIQUE (data_schema, workspace_id, lease_id, create_epoch),
  FOREIGN KEY (data_schema, workspace_id, sandbox_group_id)
    REFERENCES opengeni_private.native_command_group_births(data_schema, workspace_id, sandbox_group_id),
  FOREIGN KEY (data_schema, workspace_id, qualification_id)
    REFERENCES opengeni_private.native_command_qualifications(data_schema, workspace_id, id)
);

-- Append only after the actual canonical WARMING -> WARM transition, with
-- its committed epoch. Unknown creates and merely attributed warming boxes
-- cannot become eligible for commands. Replacements require a fresh create.
CREATE TABLE opengeni_private.native_command_provider_bindings (
  data_schema text NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  sandbox_group_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  create_operation_id text NOT NULL,
  instance_id text NOT NULL,
  warm_epoch bigint NOT NULL CHECK (warm_epoch >= 0),
  PRIMARY KEY (data_schema, workspace_id, lease_id, create_operation_id),
  FOREIGN KEY (data_schema, workspace_id, lease_id, create_operation_id)
    REFERENCES opengeni_private.native_command_provider_enrollments(data_schema, workspace_id, lease_id, create_operation_id)
);

DO $owner_posture$
DECLARE relation_name text; owner_name text := current_user; role_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['native_command_qualifications', 'native_command_group_births',
    'native_command_provider_enrollments', 'native_command_provider_bindings'] LOOP
    EXECUTE format('ALTER TABLE opengeni_private.%I ENABLE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('ALTER TABLE opengeni_private.%I FORCE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('CREATE POLICY native_command_owner ON opengeni_private.%I FOR ALL USING (current_user = %L) WITH CHECK (current_user = %L)',
      relation_name, owner_name, owner_name);
    EXECUTE format('REVOKE ALL ON TABLE opengeni_private.%I FROM PUBLIC', relation_name);
    FOR role_name IN
      SELECT DISTINCT role.rolname FROM pg_class relation
      CROSS JOIN LATERAL aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
      JOIN pg_roles role ON role.oid = acl.grantee
      WHERE relation.oid = format('opengeni_private.%I', relation_name)::regclass
        AND acl.grantee <> relation.relowner
    LOOP
      EXECUTE format('REVOKE ALL ON TABLE opengeni_private.%I FROM %I', relation_name, role_name);
    END LOOP;
  END LOOP;
END
$owner_posture$;

CREATE FUNCTION opengeni_private.native_command_qualification_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Native command qualification evidence is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'enrollment_enabled') IS DISTINCT FROM
    (to_jsonb(OLD) - 'enrollment_enabled') THEN
    RAISE EXCEPTION 'Native command qualification evidence is immutable' USING ERRCODE = '55000';
  END IF;
  -- Publishing callers take this before touching rows. Birth readers hold a
  -- shared advisory lock and use MVCC reads, never a qualification row lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('native-command-qualification:' || NEW.data_schema || ':' || NEW.workspace_id::text, 0));
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM opengeni_private.native_command_qualifications q
    WHERE q.data_schema = NEW.data_schema AND q.workspace_id = NEW.workspace_id
      AND q.activation_generation >= NEW.activation_generation) THEN
    RAISE EXCEPTION 'Native command qualification generation must advance' USING ERRCODE = '55000';
  END IF;
  IF NEW.enrollment_enabled AND EXISTS (SELECT 1 FROM opengeni_private.native_command_qualifications q
    WHERE q.data_schema = NEW.data_schema AND q.workspace_id = NEW.workspace_id
      AND q.activation_generation > NEW.activation_generation) THEN
    RAISE EXCEPTION 'Native command qualification cannot reactivate an older generation' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER native_command_qualification_guard BEFORE INSERT OR UPDATE OR DELETE
  ON opengeni_private.native_command_qualifications FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.native_command_qualification_guard();

CREATE FUNCTION opengeni_private.native_command_receipt_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  RAISE EXCEPTION 'Native command enrollment evidence is immutable' USING ERRCODE = '55000';
END
$guard$;
CREATE TRIGGER native_command_birth_immutable BEFORE UPDATE OR DELETE
  ON opengeni_private.native_command_group_births FOR EACH ROW EXECUTE FUNCTION opengeni_private.native_command_receipt_immutable();
CREATE TRIGGER native_command_enrollment_immutable BEFORE UPDATE OR DELETE
  ON opengeni_private.native_command_provider_enrollments FOR EACH ROW EXECUTE FUNCTION opengeni_private.native_command_receipt_immutable();
CREATE TRIGGER native_command_binding_immutable BEFORE UPDATE OR DELETE
  ON opengeni_private.native_command_provider_bindings FOR EACH ROW EXECUTE FUNCTION opengeni_private.native_command_receipt_immutable();

DO $target_contract$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.freeze_native_command_group_birth() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $birth$
    BEGIN
      IF NEW.sandbox_group_id = NEW.id AND NEW.sandbox_backend = 'modal'
        AND NEW.created_by_kind = 'subject' THEN
        PERFORM pg_advisory_xact_lock_shared(hashtextextended('native-command-qualification:' || %2$L || ':' || NEW.workspace_id::text, 0));
        INSERT INTO opengeni_private.native_command_group_births
          (data_schema, account_id, workspace_id, sandbox_group_id, qualification_id,
            creator_kind, creator_subject_id, create_idempotency_key)
        SELECT %2$L, NEW.account_id, NEW.workspace_id, NEW.id, q.id,
          NEW.created_by_kind, NEW.created_by_subject_id, NEW.create_idempotency_key
        FROM opengeni_private.native_command_qualifications q
        WHERE q.data_schema = %2$L AND q.account_id = NEW.account_id
          AND q.workspace_id = NEW.workspace_id AND q.enrollment_enabled
          AND q.creator_kind = NEW.created_by_kind AND q.creator_subject_id = NEW.created_by_subject_id
          AND q.create_idempotency_key = NEW.create_idempotency_key;
      END IF;
      RETURN NEW;
    END
    $birth$;
    CREATE TRIGGER freeze_native_command_group_birth AFTER INSERT ON %1$I.sessions
      FOR EACH ROW EXECUTE FUNCTION %1$I.freeze_native_command_group_birth();

    CREATE FUNCTION %1$I.freeze_native_command_provider_enrollment() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $physical$
    DECLARE birth opengeni_private.native_command_group_births%%ROWTYPE;
      qualification opengeni_private.native_command_qualifications%%ROWTYPE;
      enrollment opengeni_private.native_command_provider_enrollments%%ROWTYPE;
      attempt jsonb := NEW.provider_create_attempt;
      image_source jsonb := attempt->'nativeImageSource';
    BEGIN
      SELECT * INTO birth FROM opengeni_private.native_command_group_births b
        WHERE b.data_schema = %2$L AND b.workspace_id = NEW.workspace_id
          AND b.sandbox_group_id = NEW.sandbox_group_id;
      IF NOT FOUND THEN RETURN NEW; END IF;
      SELECT * INTO STRICT qualification FROM opengeni_private.native_command_qualifications q
        WHERE q.data_schema = birth.data_schema AND q.workspace_id = birth.workspace_id AND q.id = birth.qualification_id;
      IF birth.account_id IS DISTINCT FROM NEW.account_id OR birth.account_id IS DISTINCT FROM qualification.account_id
        OR birth.creator_kind IS DISTINCT FROM 'subject' OR birth.creator_kind IS DISTINCT FROM qualification.creator_kind
        OR birth.creator_subject_id IS DISTINCT FROM qualification.creator_subject_id
        OR birth.create_idempotency_key IS DISTINCT FROM qualification.create_idempotency_key THEN
        RAISE EXCEPTION 'Qualified native command birth selector is inconsistent' USING ERRCODE = '55000';
      END IF;
      IF NEW.backend <> 'modal' THEN
        RAISE EXCEPTION 'Qualified native command group requires Modal physical provenance' USING ERRCODE = '55000';
      END IF;
      IF attempt IS NOT NULL AND (
        attempt->>'imageRef' IS DISTINCT FROM qualification.image_ref
        OR attempt->>'providerBindingKey' IS DISTINCT FROM qualification.provider_binding_key
        OR attempt->'nativeCommandQualification' IS DISTINCT FROM jsonb_build_object(
          'qualificationId', qualification.id, 'activationGeneration', qualification.activation_generation,
          'sourceSha', qualification.source_sha, 'imageRef', qualification.image_ref,
          'providerImageId', qualification.provider_image_id, 'providerBindingKey', qualification.provider_binding_key,
          'acceptanceEvidenceHash', qualification.acceptance_evidence_hash)) THEN
        RAISE EXCEPTION 'Qualified native command create descriptor is immutable' USING ERRCODE = '55000';
      END IF;
      IF attempt IS NULL AND NEW.liveness = 'warm' THEN
        RAISE EXCEPTION 'Qualified native command warm binding requires exact create receipt' USING ERRCODE = '55000';
      END IF;
      IF attempt IS NOT NULL THEN
        SELECT * INTO enrollment FROM opengeni_private.native_command_provider_enrollments e
          WHERE e.data_schema = %2$L AND e.workspace_id = NEW.workspace_id AND e.lease_id = NEW.id
            AND e.create_operation_id = attempt->>'operationId';
        IF FOUND AND (attempt - 'instanceId') IS DISTINCT FROM (enrollment.create_attempt - 'instanceId') THEN
          RAISE EXCEPTION 'Qualified native command create request is immutable' USING ERRCODE = '55000';
        END IF;
        IF attempt->>'operationId' = OLD.provider_create_attempt->>'operationId'
          AND OLD.provider_create_attempt->>'instanceId' IS NOT NULL
          AND attempt->>'instanceId' IS DISTINCT FROM OLD.provider_create_attempt->>'instanceId' THEN
          RAISE EXCEPTION 'Qualified native command provider attribution is immutable' USING ERRCODE = '55000';
        END IF;
      END IF;
      IF attempt IS DISTINCT FROM OLD.provider_create_attempt
        AND attempt->'instanceId' = 'null'::jsonb THEN
        -- The stock pin identifies an actual authenticated provider image,
        -- not a logical config string. Snapshot lineage comes from the exact
        -- canonical selected immutable artifact and enrolled predecessor.
        IF NOT ((image_source->>'imageId' = attempt->>'imageId'
          AND image_source - ARRAY['kind','imageId','checkpointArtifactId'] = '{}'::jsonb
          AND (image_source->>'kind' = 'stock-registry' AND attempt->>'imageId' = qualification.provider_image_id
            OR image_source->>'kind' = 'qualified-filesystem-snapshot' AND EXISTS (
              SELECT 1 FROM %1$I.sandbox_checkpoint_artifacts artifact
              WHERE artifact.id = NEW.current_checkpoint_artifact_id
                AND artifact.object_id = attempt->>'imageId' AND artifact.object_kind = 'modal_filesystem_snapshot'
            ))
          AND (image_source->'checkpointArtifactId' = 'null'::jsonb
            AND image_source->>'kind' = 'stock-registry'
            AND (NEW.resume_state #>> '{opengeniRecovery,archive,current,provider}') IS DISTINCT FROM 'modal_snapshot_filesystem'
            AND (NEW.resume_state #>> '{opengeniRecovery,archive,current,provider}') IS DISTINCT FROM 'modal_snapshot_directory'
            OR EXISTS (
              SELECT 1 FROM %1$I.sandbox_checkpoint_artifacts artifact
              JOIN opengeni_private.native_command_provider_bindings binding ON binding.data_schema = %2$L
                AND binding.workspace_id = artifact.workspace_id AND binding.sandbox_group_id = artifact.sandbox_group_id
                AND binding.lease_id = artifact.source_lease_id AND binding.warm_epoch = artifact.source_lease_epoch
                AND binding.instance_id = artifact.source_instance_id
              JOIN opengeni_private.native_command_provider_enrollments source ON source.data_schema = binding.data_schema
                AND source.workspace_id = binding.workspace_id AND source.lease_id = binding.lease_id
                AND source.create_operation_id = binding.create_operation_id AND source.qualification_id = qualification.id
              WHERE artifact.id = NEW.current_checkpoint_artifact_id
                AND artifact.id::text = image_source->>'checkpointArtifactId'
                AND artifact.account_id = NEW.account_id AND artifact.workspace_id = NEW.workspace_id
                AND artifact.sandbox_group_id = NEW.sandbox_group_id AND artifact.source_lease_id = NEW.id
                AND artifact.provenance = 'native_capture' AND artifact.state = 'current'
                AND artifact.provider_backend = 'modal' AND artifact.provider_binding_key = qualification.provider_binding_key
                AND artifact.descriptor_revision = attempt->>'selectedRevision'
                AND attempt->>'rematerializationId' = NEW.resume_state #>> '{opengeniRecovery,restore,rematerializationId}'
                AND artifact.descriptor_revision = NEW.resume_state #>> '{opengeniRecovery,restore,selectedRevision}'
                AND artifact.object_id = NEW.resume_state #>> '{opengeniRecovery,archive,current,snapshotId}'
                AND artifact.descriptor_revision = NEW.resume_state #>> '{opengeniRecovery,archive,current,revision}'
                AND (artifact.object_kind = 'modal_filesystem_snapshot'
                  AND image_source->>'kind' = 'qualified-filesystem-snapshot' AND artifact.object_id = attempt->>'imageId'
                  OR artifact.object_kind = 'modal_directory_snapshot'
                  AND image_source->>'kind' = 'stock-registry' AND attempt->>'imageId' = qualification.provider_image_id)
            ))) IS TRUE) THEN
          RAISE EXCEPTION 'Qualified native command actual image or checkpoint lineage is unqualified' USING ERRCODE = '55000';
        END IF;
        IF NEW.liveness <> 'warming' OR NEW.instance_id IS NOT NULL
          OR (attempt->>'leaseEpoch')::bigint IS DISTINCT FROM NEW.lease_epoch
          OR attempt->>'imageRef' IS DISTINCT FROM qualification.image_ref
          OR attempt->>'operationId' IS NOT DISTINCT FROM OLD.provider_create_attempt->>'operationId' THEN
          RAISE EXCEPTION 'Qualified native command create requires exact fresh image and operation' USING ERRCODE = '55000';
        END IF;
        INSERT INTO opengeni_private.native_command_provider_enrollments
          (data_schema, account_id, workspace_id, sandbox_group_id, lease_id, create_operation_id,
            create_epoch, qualification_id, create_attempt)
        VALUES (%2$L, NEW.account_id, NEW.workspace_id, NEW.sandbox_group_id, NEW.id,
          attempt->>'operationId', NEW.lease_epoch, qualification.id, attempt);
      END IF;
      IF NEW.liveness = 'warm' AND OLD.liveness = 'warming' THEN
        SELECT * INTO enrollment FROM opengeni_private.native_command_provider_enrollments e
          WHERE e.data_schema = %2$L AND e.workspace_id = NEW.workspace_id AND e.lease_id = NEW.id
            AND e.create_operation_id = attempt->>'operationId';
        IF NOT FOUND OR enrollment.qualification_id <> qualification.id
          OR (attempt - 'instanceId') IS DISTINCT FROM (enrollment.create_attempt - 'instanceId')
          OR attempt->>'instanceId' IS DISTINCT FROM NEW.instance_id
          OR NEW.instance_id IS NULL OR NEW.lease_epoch <> OLD.lease_epoch + 1
          OR OLD.lease_epoch <> enrollment.create_epoch THEN
          RAISE EXCEPTION 'Qualified native command warm binding requires exact create receipt' USING ERRCODE = '55000';
        END IF;
        INSERT INTO opengeni_private.native_command_provider_bindings
          (data_schema, account_id, workspace_id, sandbox_group_id, lease_id, create_operation_id, instance_id, warm_epoch)
        VALUES (%2$L, NEW.account_id, NEW.workspace_id, NEW.sandbox_group_id, NEW.id,
          enrollment.create_operation_id, NEW.instance_id, NEW.lease_epoch);
      END IF;
      RETURN NEW;
    END
    $physical$;
    CREATE TRIGGER freeze_native_command_provider_enrollment AFTER UPDATE OF
      provider_create_attempt, liveness ON %1$I.sandbox_leases
      FOR EACH ROW EXECUTE FUNCTION %1$I.freeze_native_command_provider_enrollment();

    CREATE FUNCTION %1$I.native_command_birth_qualification(p_account uuid, p_workspace uuid, p_group uuid)
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
        'protocols', q.protocols, 'acceptanceEvidenceHash', q.acceptance_evidence_hash);
    END
    $read$;

    CREATE FUNCTION %1$I.native_command_provider_qualification(p_account uuid, p_workspace uuid,
      p_group uuid, p_instance text, p_epoch bigint)
    RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $read$
    DECLARE qualification jsonb; candidate record;
    BEGIN
      qualification := %1$I.native_command_birth_qualification(p_account, p_workspace, p_group);
      IF qualification IS NULL THEN RETURN jsonb_build_object('status', 'legacy'); END IF;
      SELECT lease.*, binding.warm_epoch, binding.instance_id AS qualified_instance,
        enrollment.create_attempt AS qualified_attempt INTO candidate
      FROM %1$I.sandbox_leases lease
      LEFT JOIN opengeni_private.native_command_provider_bindings binding ON binding.data_schema = %2$L
        AND binding.workspace_id = lease.workspace_id AND binding.lease_id = lease.id
        AND binding.create_operation_id = lease.provider_create_attempt->>'operationId'
      LEFT JOIN opengeni_private.native_command_provider_enrollments enrollment ON enrollment.data_schema = binding.data_schema
        AND enrollment.workspace_id = binding.workspace_id AND enrollment.lease_id = binding.lease_id
        AND enrollment.create_operation_id = binding.create_operation_id
      WHERE lease.account_id = p_account AND lease.workspace_id = p_workspace AND lease.sandbox_group_id = p_group;
      IF NOT FOUND OR candidate.backend <> 'modal' OR candidate.liveness <> 'warm'
        OR candidate.instance_id IS DISTINCT FROM p_instance OR candidate.lease_epoch IS DISTINCT FROM p_epoch
        OR candidate.qualified_instance IS DISTINCT FROM p_instance OR candidate.warm_epoch IS DISTINCT FROM p_epoch
        OR candidate.qualified_attempt IS NULL
        OR (candidate.provider_create_attempt - 'instanceId') IS DISTINCT FROM (candidate.qualified_attempt - 'instanceId')
        OR candidate.provider_create_attempt->>'instanceId' IS DISTINCT FROM p_instance THEN
        RETURN jsonb_build_object('status', 'blocked', 'reason', 'physical_binding_unqualified', 'qualification', qualification);
      END IF;
      RETURN jsonb_build_object('status', 'enrolled', 'qualification', qualification);
    END
    $read$;
  $ddl$, target_schema, target_schema);
END
$target_contract$;

-- Trigger routines have no caller RPC. Read routines are the only runtime
-- seams; strip hostile defaults before explicitly granting scoped readers.
DO $function_acl$
DECLARE target_schema text := current_schema(); routine regprocedure; role_name text; signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'opengeni_private.native_command_qualification_guard()',
    'opengeni_private.native_command_receipt_immutable()',
    format('%I.freeze_native_command_group_birth()', target_schema),
    format('%I.freeze_native_command_provider_enrollment()', target_schema),
    format('%I.native_command_birth_qualification(uuid,uuid,uuid)', target_schema),
    format('%I.native_command_provider_qualification(uuid,uuid,uuid,text,bigint)', target_schema)
  ] LOOP
    routine := signature::regprocedure;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine);
    FOR role_name IN SELECT DISTINCT role.rolname FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      JOIN pg_roles role ON role.oid = acl.grantee WHERE p.oid = routine AND acl.grantee <> p.proowner
    LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', routine, role_name); END LOOP;
  END LOOP;
  FOR role_name IN SELECT jsonb_array_elements_text(coalesce(nullif(
    current_setting('opengeni.migration_application_roles', true), '')::jsonb, '[]'::jsonb)) LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.native_command_birth_qualification(uuid,uuid,uuid), %I.native_command_provider_qualification(uuid,uuid,uuid,text,bigint) TO %I',
        target_schema, target_schema, role_name);
    END IF;
  END LOOP;
END
$function_acl$;
