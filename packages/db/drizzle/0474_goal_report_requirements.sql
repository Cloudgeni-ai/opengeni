-- deployment-mode: rolling
-- Rolling-compatible storage fences. Existing non-report goals are unchanged.
-- No caller boolean can waive a persisted requirement, including old binaries.
-- Trust boundary: authenticated agent/API callers can supply receipt IDs, never
-- receipt bodies. Trusted application code records proof after native query and
-- decode. The runtime SQL role can INSERT these rows and is inside that trust
-- boundary; these guards are retention/integrity checks, not an attestation
-- against compromised application-role SQL or database administrators.
CREATE FUNCTION session_goal_report_requirements_before_write()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requirements jsonb := coalesce(NEW.metadata -> 'reportRequirementsV1', '[]'::jsonb);
DECLARE previous_requirements jsonb;
DECLARE deliveries jsonb;
DECLARE requirement jsonb;
DECLARE delivery jsonb;
DECLARE artifact record;
BEGIN
  IF jsonb_typeof(requirements) <> 'array' OR jsonb_array_length(requirements) > 16 THEN
    RAISE EXCEPTION 'Invalid goal report requirements' USING ERRCODE = '23514';
  END IF;
  FOR requirement IN SELECT value FROM jsonb_array_elements(requirements) LOOP
    IF jsonb_typeof(requirement) <> 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(requirement)) <> 2
      OR jsonb_typeof(requirement -> 'id') IS DISTINCT FROM 'string'
      OR (requirement ->> 'id') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
      OR jsonb_typeof(requirement -> 'title') IS DISTINCT FROM 'string'
      OR octet_length(requirement ->> 'title') NOT BETWEEN 1 AND 512
      OR btrim(requirement ->> 'title') = ''
    THEN RAISE EXCEPTION 'Invalid goal report requirement' USING ERRCODE = '23514'; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT value ->> 'id') FROM jsonb_array_elements(requirements)) <> jsonb_array_length(requirements) THEN
    RAISE EXCEPTION 'Duplicate goal report requirement IDs' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NOT (OLD.status = 'completed' AND NEW.status = 'active') THEN
    previous_requirements := coalesce(OLD.metadata -> 'reportRequirementsV1', '[]'::jsonb);
    IF NOT requirements @> previous_requirements THEN
      RAISE EXCEPTION 'Goal report requirements are append-only until completed-goal replacement' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'completed' AND (requirements <> previous_requirements OR NEW.metadata -> 'reportDeliveriesV1' IS DISTINCT FROM OLD.metadata -> 'reportDeliveriesV1') THEN
      RAISE EXCEPTION 'Completed report requirements and deliveries are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'completed' AND NEW.status = 'active' THEN
    -- Old rolling writers retain metadata on replacement. They must never
    -- reuse a previous goal's verified delivery to complete the new goal.
    NEW.metadata := jsonb_set(NEW.metadata, '{reportDeliveriesV1}', '[]'::jsonb);
  END IF;
  IF NEW.status = 'completed' AND (TG_OP = 'INSERT' OR OLD.status <> 'completed') AND jsonb_array_length(requirements) > 0 THEN
    deliveries := coalesce(NEW.metadata -> 'reportDeliveriesV1', '[]'::jsonb);
    IF jsonb_typeof(deliveries) <> 'array' OR jsonb_array_length(deliveries) <> jsonb_array_length(requirements)
      OR (SELECT count(DISTINCT value ->> 'requirementId') FROM jsonb_array_elements(deliveries)) <> jsonb_array_length(requirements)
    THEN RAISE EXCEPTION 'Missing report deliveries' USING ERRCODE = '23514'; END IF;
    -- Same no-wait lock policy as the application: artifact writers already
    -- lock the aggregate before checking their actor's session authority.
    FOR delivery IN SELECT value FROM jsonb_array_elements(deliveries) ORDER BY value ->> 'artifactId' LOOP
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(requirements) r WHERE r ->> 'id' = delivery ->> 'requirementId') THEN
        RAISE EXCEPTION 'Unknown report requirement' USING ERRCODE = '23514';
      END IF;
      SELECT head_sequence, state_hash, authorization_revision INTO artifact FROM editable_artifacts
        WHERE account_id = NEW.account_id AND workspace_id = NEW.workspace_id
          AND id = delivery ->> 'artifactId' AND modality = 'document' AND lifecycle_state = 'active'
        FOR SHARE NOWAIT;
      IF NOT FOUND THEN RAISE EXCEPTION 'Report document unavailable' USING ERRCODE = '23514'; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM session_command_receipts receipt
        WHERE receipt.id::text = delivery ->> 'inspectionReceiptId'
          AND receipt.account_id = NEW.account_id AND receipt.workspace_id = NEW.workspace_id
          AND receipt.target_session_id = NEW.session_id
          AND receipt.actor_type = 'agent_attempt' AND receipt.action = 'artifact.document.inspect'
          AND receipt.result ->> 'version' = 'native-document-inspection.v1'
          AND receipt.result ->> 'queryKind' = 'body'
          AND receipt.result ->> 'artifactId' = delivery ->> 'artifactId'
          AND receipt.result ->> 'headSequence' = artifact.head_sequence::text
          AND receipt.result ->> 'stateHash' = artifact.state_hash
          AND receipt.result ->> 'authorizationRevision' = artifact.authorization_revision::text
      ) THEN RAISE EXCEPTION 'Missing or stale document inspection proof' USING ERRCODE = '23514'; END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER session_goal_report_requirements_before_write_trigger
  BEFORE INSERT OR UPDATE OF metadata, status ON session_goals
  FOR EACH ROW EXECUTE FUNCTION session_goal_report_requirements_before_write();

-- Runs after the existing snapshot freeze trigger, without rewriting old turns.
CREATE FUNCTION session_goal_freeze_report_requirements()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requirements jsonb;
BEGIN
  IF NEW.goal_snapshot ->> 'state' <> 'none' THEN
    SELECT coalesce(metadata -> 'reportRequirementsV1', '[]'::jsonb) INTO requirements
      FROM session_goals WHERE workspace_id = NEW.workspace_id AND session_id = NEW.session_id;
    NEW.goal_snapshot := NEW.goal_snapshot || jsonb_build_object('reportRequirements', coalesce(requirements, '[]'::jsonb));
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER zz_session_goal_freeze_report_requirements_trigger
  BEFORE INSERT ON session_turns
  FOR EACH ROW EXECUTE FUNCTION session_goal_freeze_report_requirements();

CREATE FUNCTION session_document_inspection_receipt_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.action = 'artifact.document.inspect' OR NEW.action = 'artifact.document.inspect') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Native document inspection receipts are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER session_document_inspection_receipt_immutable_trigger
  BEFORE UPDATE ON session_command_receipts
  FOR EACH ROW EXECUTE FUNCTION session_document_inspection_receipt_immutable();

CREATE FUNCTION session_document_inspection_receipt_retained()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Keep proof while its session exists. FK retention cascades remove the
  -- session first and must remain able to delete its receipts. Checking parent
  -- existence also prevents using an unrelated nested trigger to bypass this.
  IF OLD.action = 'artifact.document.inspect' AND EXISTS (
    SELECT 1 FROM sessions WHERE account_id = OLD.account_id
      AND workspace_id = OLD.workspace_id AND id = OLD.target_session_id
  ) THEN
    RAISE EXCEPTION 'Native document inspection receipts are retained with their session' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER session_document_inspection_receipt_retained_trigger
  BEFORE DELETE ON session_command_receipts
  FOR EACH ROW EXECUTE FUNCTION session_document_inspection_receipt_retained();

CREATE FUNCTION session_goal_report_requirements_before_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Parent session/workspace deletion remains cancellation, not completion.
  -- Ordinary goal clearing must carry the exact trusted API cancellation stamp.
  IF pg_trigger_depth() = 1 AND OLD.status <> 'completed'
    AND jsonb_array_length(coalesce(OLD.metadata -> 'reportRequirementsV1', '[]'::jsonb)) > 0
    AND current_setting('opengeni.goal_report_clear_id', true) IS DISTINCT FROM OLD.id::text
  THEN
    RAISE EXCEPTION 'Pending report requirements require explicit API cancellation' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER session_goal_report_requirements_before_delete_trigger
  BEFORE DELETE ON session_goals
  FOR EACH ROW EXECUTE FUNCTION session_goal_report_requirements_before_delete();