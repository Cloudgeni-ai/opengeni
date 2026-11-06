-- deployment-mode: rolling
-- contract-step: after #6389 removed resumable transcription, #6710/#6714 shipped readiness and ORM retirement, and outstanding legacy object deletion has been independently confirmed; advance the pinned previous-production baseline separately before queueing.
-- Never discard the only cleanup ledger for stored audio. This contract does
-- not mark an object deleted, erase an obligation or infer deletion from age.
SET LOCAL lock_timeout = '5s';

ALTER TABLE transcription_recordings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE transcription_recording_chunks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE transcription_recording_segments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE transcription_recording_objects NO FORCE ROW LEVEL SECURITY;

DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM transcription_recording_objects WHERE cleaned_at IS NULL) THEN
    RAISE EXCEPTION 'legacy recording objects must be confirmed deleted before contraction'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM transcription_recordings WHERE processing_owner IS NOT NULL)
    OR EXISTS (SELECT 1 FROM transcription_recording_segments WHERE attempt_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'legacy transcription processing must drain before contraction'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM transcription_recording_chunks chunk
    WHERE NOT EXISTS (
      SELECT 1 FROM transcription_recording_objects object
      WHERE object.account_id = chunk.account_id AND object.workspace_id = chunk.workspace_id
        AND object.recording_id = chunk.recording_id AND object.object_key = chunk.object_key
        AND object.kind = 'chunk' AND object.cleaned_at IS NOT NULL
    )
  ) OR EXISTS (
    SELECT 1 FROM transcription_recording_segments segment
    WHERE NOT EXISTS (
      SELECT 1 FROM transcription_recording_objects object
      WHERE object.account_id = segment.account_id AND object.workspace_id = segment.workspace_id
        AND object.recording_id = segment.recording_id AND object.object_key = segment.object_key
        AND object.kind = 'segment' AND object.cleaned_at IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'every legacy audio reference requires its matching confirmed deletion record'
      USING ERRCODE = '55000';
  END IF;
END
$preflight$;

DO $install$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.fence_legacy_lossless_content_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF current_setting('opengeni.lossless_content_writer', true) = '1'
    OR current_setting('application_name', true) IN (
      'opengeni-lossless-v1',
      'opengeni-lossless-v1-session-variable-sets-v1'
    )
  THEN
    RETURN NEW;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'sessions' THEN
      IF NEW.initial_message IS DISTINCT FROM OLD.initial_message
        AND NEW.initial_message_codec_version IS NOT DISTINCT FROM OLD.initial_message_codec_version THEN
        NEW.initial_message_codec_version := NULL;
      END IF;
    WHEN 'session_realtime_entries' THEN
      IF NEW.text IS DISTINCT FROM OLD.text
        AND NEW.text_codec_version IS NOT DISTINCT FROM OLD.text_codec_version THEN
        NEW.text_codec_version := NULL;
      END IF;
      IF NEW.payload IS DISTINCT FROM OLD.payload
        AND NEW.payload_codec_version IS NOT DISTINCT FROM OLD.payload_codec_version THEN
        NEW.payload_codec_version := NULL;
      END IF;
    WHEN 'knowledge_memories' THEN
      IF NEW.text IS DISTINCT FROM OLD.text
        AND NEW.text_codec_version IS NOT DISTINCT FROM OLD.text_codec_version THEN
        NEW.text_codec_version := NULL;
      END IF;
    WHEN 'session_turns' THEN
      IF NEW.prompt IS DISTINCT FROM OLD.prompt
        AND NEW.prompt_codec_version IS NOT DISTINCT FROM OLD.prompt_codec_version THEN
        NEW.prompt_codec_version := NULL;
      END IF;
    WHEN 'session_system_updates' THEN
      IF NEW.summary IS DISTINCT FROM OLD.summary
        AND NEW.summary_codec_version IS NOT DISTINCT FROM OLD.summary_codec_version THEN
        NEW.summary_codec_version := NULL;
      END IF;
      IF NEW.payload IS DISTINCT FROM OLD.payload
        AND NEW.payload_codec_version IS NOT DISTINCT FROM OLD.payload_codec_version THEN
        NEW.payload_codec_version := NULL;
      END IF;
    WHEN 'session_system_update_outbox' THEN
      IF NEW.summary IS DISTINCT FROM OLD.summary
        AND NEW.summary_codec_version IS NOT DISTINCT FROM OLD.summary_codec_version THEN
        NEW.summary_codec_version := NULL;
      END IF;
      IF NEW.payload IS DISTINCT FROM OLD.payload
        AND NEW.payload_codec_version IS NOT DISTINCT FROM OLD.payload_codec_version THEN
        NEW.payload_codec_version := NULL;
      END IF;
    WHEN 'session_events' THEN
      IF NEW.payload IS DISTINCT FROM OLD.payload
        AND NEW.payload_codec_version IS NOT DISTINCT FROM OLD.payload_codec_version THEN
        NEW.payload_codec_version := NULL;
      END IF;
    WHEN 'host_export_outbox' THEN
      IF NEW.payload IS DISTINCT FROM OLD.payload
        AND NEW.payload_codec_version IS NOT DISTINCT FROM OLD.payload_codec_version THEN
        NEW.payload_codec_version := NULL;
      END IF;
    WHEN 'host_export_consumers' THEN
      IF NEW.last_error IS DISTINCT FROM OLD.last_error
        AND NEW.last_error_codec_version IS NOT DISTINCT FROM OLD.last_error_codec_version THEN
        NEW.last_error_codec_version := NULL;
      END IF;
    WHEN 'agent_run_states' THEN
      IF NEW.serialized_run_state IS DISTINCT FROM OLD.serialized_run_state
        AND NEW.serialized_run_state_codec_version IS NOT DISTINCT FROM OLD.serialized_run_state_codec_version THEN
        NEW.serialized_run_state_codec_version := NULL;
      END IF;
      IF NEW.pending_approvals IS DISTINCT FROM OLD.pending_approvals
        AND NEW.pending_approvals_codec_version IS NOT DISTINCT FROM OLD.pending_approvals_codec_version THEN
        NEW.pending_approvals_codec_version := NULL;
      END IF;
    WHEN 'session_history_items' THEN
      IF NEW.item IS DISTINCT FROM OLD.item
        AND NEW.item_codec_version IS NOT DISTINCT FROM OLD.item_codec_version THEN
        NEW.item_codec_version := NULL;
      END IF;
    WHEN 'session_pending_tool_calls' THEN
      IF NEW.call_item IS DISTINCT FROM OLD.call_item
        AND NEW.call_item_codec_version IS NOT DISTINCT FROM OLD.call_item_codec_version THEN
        NEW.call_item_codec_version := NULL;
      END IF;
      IF NEW.result_item IS DISTINCT FROM OLD.result_item
        AND NEW.result_item_codec_version IS NOT DISTINCT FROM OLD.result_item_codec_version THEN
        NEW.result_item_codec_version := NULL;
      END IF;
    WHEN 'sandbox_session_envelopes' THEN
      IF NEW.envelope IS DISTINCT FROM OLD.envelope
        AND NEW.envelope_codec_version IS NOT DISTINCT FROM OLD.envelope_codec_version THEN
        NEW.envelope_codec_version := NULL;
      END IF;
    WHEN 'session_recordings' THEN
      IF NEW.reason IS DISTINCT FROM OLD.reason
        AND NEW.reason_codec_version IS NOT DISTINCT FROM OLD.reason_codec_version THEN
        NEW.reason_codec_version := NULL;
      END IF;
    WHEN 'host_export_dead_letters' THEN
      IF NEW.envelope IS DISTINCT FROM OLD.envelope
        AND NEW.envelope_codec_version IS NOT DISTINCT FROM OLD.envelope_codec_version THEN
        NEW.envelope_codec_version := NULL;
      END IF;
      IF NEW.envelope #> '{event,payload}' IS DISTINCT FROM OLD.envelope #> '{event,payload}'
        AND NEW.event_payload_codec_version IS NOT DISTINCT FROM OLD.event_payload_codec_version THEN
        NEW.event_payload_codec_version := NULL;
      END IF;
    WHEN 'audit_events' THEN
      IF NEW.metadata IS DISTINCT FROM OLD.metadata
        AND NEW.metadata_codec_version IS NOT DISTINCT FROM OLD.metadata_codec_version THEN
        NEW.metadata_codec_version := NULL;
      END IF;
    WHEN 'rig_changes' THEN
      IF NEW.payload IS DISTINCT FROM OLD.payload
        AND NEW.payload_codec_version IS NOT DISTINCT FROM OLD.payload_codec_version THEN
        NEW.payload_codec_version := NULL;
      END IF;
      IF NEW.verification IS DISTINCT FROM OLD.verification
        AND NEW.verification_codec_version IS NOT DISTINCT FROM OLD.verification_codec_version THEN
        NEW.verification_codec_version := NULL;
      END IF;
    ELSE
      RAISE EXCEPTION 'unsupported lossless-content fence table: %%', TG_TABLE_NAME;
  END CASE;
  RETURN NEW;
END
$function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.organization_retention_object_candidates(p_account_id uuid, p_membership_id uuid)
 RETURNS TABLE(object_kind text, source_id text, object_bucket text, object_key text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$L, 'pg_temp'
AS $function$
  WITH authority_context AS MATERIALIZED (
    SELECT opengeni_private.assert_organization_retention_account(p_account_id)
  ), member AS (
    SELECT membership.personal_workspace_id
    FROM organization_memberships membership
    CROSS JOIN authority_context
    WHERE membership.account_id = p_account_id
      AND membership.id = p_membership_id
  )
  SELECT 'file'::text, candidate.file_id::text, candidate.object_bucket, candidate.object_key
  FROM opengeni_private.organization_retention_file_candidates(
    p_account_id, p_membership_id
  ) candidate
  UNION ALL
  SELECT 'session_recording', recording.id::text, NULL::text, recording.storage_key
  FROM session_recordings recording CROSS JOIN member
  WHERE recording.account_id = p_account_id
    AND recording.workspace_id = member.personal_workspace_id
    AND recording.storage_key IS NOT NULL
  UNION ALL
  SELECT 'browser_state_artifact', artifact.id::text, NULL::text, artifact.object_key
  FROM browser_state_artifacts artifact CROSS JOIN member
  WHERE artifact.account_id = p_account_id
    AND artifact.workspace_id = member.personal_workspace_id
    AND artifact.state <> 'deleted'
  UNION ALL
  SELECT 'browser_state_upload', upload.id::text, NULL::text, upload.object_key
  FROM browser_state_uploads upload CROSS JOIN member
  WHERE upload.account_id = p_account_id
    AND upload.workspace_id = member.personal_workspace_id
    AND upload.state <> 'deleted'
    AND (
      upload.state <> 'committed'
      OR NOT EXISTS (
        SELECT 1
        FROM browser_state_artifacts committed
        WHERE committed.account_id = upload.account_id
          AND committed.workspace_id = upload.workspace_id
          AND committed.id = upload.committed_artifact_id
          AND committed.object_key = upload.object_key
          AND committed.state <> 'deleted'
      )
    )
  UNION ALL
  SELECT 'video_staging_reference',
    reference.operation_id::text || ':' || reference.ordinal::text,
    NULL::text,
    reference.staging_object_key
  FROM video_generation_references reference CROSS JOIN member
  WHERE reference.account_id = p_account_id
    AND reference.workspace_id = member.personal_workspace_id
    AND reference.staging_object_key IS NOT NULL
    AND reference.cleaned_at IS NULL
  UNION ALL
  SELECT 'workspace_artifact_version', version.id::text, NULL::text, version.content_key
  FROM workspace_artifact_versions version CROSS JOIN member
  WHERE version.account_id = p_account_id
    AND version.workspace_id = member.personal_workspace_id
  UNION ALL
  SELECT 'editable_artifact_blob',
    blob.artifact_id || ':' || blob.id,
    NULL::text,
    blob.object_reference
  FROM editable_artifact_blob_refs blob CROSS JOIN member
  WHERE blob.account_id = p_account_id
    AND blob.workspace_id = member.personal_workspace_id
  UNION ALL
  SELECT 'workspace_capture_manifest', capture.id::text, NULL::text, capture.manifest_key
  FROM workspace_captures capture CROSS JOIN member
  WHERE capture.account_id = p_account_id
    AND capture.workspace_id = member.personal_workspace_id
    AND capture.manifest_key IS NOT NULL
  UNION ALL
  SELECT 'workspace_capture_tree_index', capture.id::text, NULL::text, capture.tree_index_key
  FROM workspace_captures capture CROSS JOIN member
  WHERE capture.account_id = p_account_id
    AND capture.workspace_id = member.personal_workspace_id
    AND capture.tree_index_key IS NOT NULL
  UNION ALL
  SELECT 'workspace_capture_blob',
    capture.id::text || ':' || blob.ordinality::text,
    NULL::text,
    blob.value #>> '{}'
  FROM workspace_captures capture CROSS JOIN member
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(capture.blob_keys) = 'array'
      THEN capture.blob_keys ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS blob(value, ordinality)
  WHERE capture.account_id = p_account_id
    AND capture.workspace_id = member.personal_workspace_id
    AND jsonb_typeof(blob.value) = 'string'
  ORDER BY 1, 2
$function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.finalize_organization_retention_deletion(p_account_id uuid, p_membership_id uuid, p_operation_id uuid, p_object_bucket text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$L, 'opengeni_private', 'pg_temp'
AS $function$
DECLARE
  member organization_memberships%%ROWTYPE;
  deletion organization_user_retention_deletions%%ROWTYPE;
  prior_event organization_user_retention_deletion_events%%ROWTYPE;
  unsupported_kind text;
  candidate_file_ids uuid[];
  deleted_documents integer := 0;
  deleted_files integer := 0;
  deleted_variable_sets integer := 0;
  deleted_rigs integer := 0;
  deleted_connections integer := 0;
  deleted_codex integer := 0;
  deleted_xai integer := 0;
  deleted_claude integer := 0;
  deleted_subscriptions integer := 0;
  tombstoned_machines integer := 0;
  deleted_workspace integer := 0;
  object_count integer := 0;
  locked_personal_workspace_id uuid;
  result_value jsonb;
BEGIN
  IF nullif(p_object_bucket, '') IS NULL
    OR octet_length(convert_to(p_object_bucket, 'UTF8')) > 1024
  THEN
    RAISE EXCEPTION 'invalid retention object bucket' USING ERRCODE = '22023';
  END IF;
  PERFORM opengeni_private.assert_organization_retention_account(p_account_id);
  PERFORM acquire_organization_session_tenancy_fences(
    p_account_id
  );
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-retention:' || p_operation_id::text, 0)
  );
  SELECT * INTO prior_event FROM organization_user_retention_deletion_events event
  WHERE event.account_id = p_account_id AND event.operation_id = p_operation_id
    AND event.kind = 'completed';
  IF FOUND THEN
    IF prior_event.membership_id IS DISTINCT FROM p_membership_id THEN
      RAISE EXCEPTION 'retention completion operation id belongs to another membership'
        USING ERRCODE = '23505';
    END IF;
    SELECT candidate.database_result INTO result_value
    FROM organization_user_retention_deletions candidate
    WHERE candidate.account_id = p_account_id
      AND candidate.membership_id = p_membership_id;
    IF NOT FOUND
      OR result_value ->> 'objectBucket' IS DISTINCT FROM p_object_bucket
    THEN
      RAISE EXCEPTION 'retention completion operation id has different frozen input'
        USING ERRCODE = '23505';
    END IF;
    RETURN result_value;
  END IF;
  SELECT * INTO member FROM organization_memberships membership
  WHERE membership.account_id = p_account_id AND membership.id = p_membership_id;
  IF NOT FOUND OR member.status <> 'revoked'
    OR member.personal_retention_until IS NULL
    OR member.personal_retention_until > clock_timestamp()
  THEN RAISE EXCEPTION 'retention membership is not eligible' USING ERRCODE = '42501'; END IF;
  locked_personal_workspace_id := member.personal_workspace_id;
  IF locked_personal_workspace_id IS NOT NULL THEN
    PERFORM 1 FROM workspaces workspace
    WHERE workspace.account_id = p_account_id
      AND workspace.id = locked_personal_workspace_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'retention personal workspace is missing' USING ERRCODE = '40001';
    END IF;
  END IF;
  SELECT * INTO member FROM organization_memberships membership
  WHERE membership.account_id = p_account_id AND membership.id = p_membership_id
  FOR UPDATE;
  IF NOT FOUND OR member.status <> 'revoked'
    OR member.personal_retention_until IS NULL
    OR member.personal_retention_until > clock_timestamp()
    OR member.personal_workspace_id IS DISTINCT FROM locked_personal_workspace_id
  THEN RAISE EXCEPTION 'retention membership changed during finalization'
    USING ERRCODE = '40001'; END IF;
  SELECT * INTO deletion FROM organization_user_retention_deletions candidate
  WHERE candidate.account_id = p_account_id AND candidate.membership_id = p_membership_id
  FOR UPDATE;
  IF NOT FOUND OR deletion.state <> 'claimed'
    OR deletion.claim_operation_id <> p_operation_id
    OR deletion.claim_expires_at <= clock_timestamp()
  THEN RAISE EXCEPTION 'retention deletion claim is stale' USING ERRCODE = '40001'; END IF;
  IF deletion.retention_until IS DISTINCT FROM member.personal_retention_until THEN
    RAISE EXCEPTION 'retention deadline changed after claim' USING ERRCODE = '40001';
  END IF;
  IF deletion.database_finalized_at IS NOT NULL THEN
    IF deletion.database_result ->> 'objectBucket' IS DISTINCT FROM p_object_bucket
      OR EXISTS (
        SELECT 1 FROM organization_user_retention_object_obligations obligation
        WHERE obligation.account_id = p_account_id
          AND obligation.membership_id = p_membership_id
          AND obligation.object_bucket <> p_object_bucket
      )
    THEN
      RAISE EXCEPTION 'retention object bucket changed after database finalization'
        USING ERRCODE = '40001';
    END IF;
    RETURN pg_catalog.jsonb_set(
      deletion.database_result,
      '{operationId}',
      pg_catalog.to_jsonb(p_operation_id::text),
      false
    );
  END IF;
  IF member.personal_workspace_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM documents document
    LEFT JOIN organization_user_resource_authorities authority
      ON authority.id = document.authority_id
     AND authority.account_id = document.account_id
     AND authority.organization_membership_id = document.owner_organization_membership_id
     AND authority.resource_kind = 'document'
     AND authority.resource_id = document.id
    WHERE document.account_id = p_account_id
      AND document.workspace_id = member.personal_workspace_id
      AND (
        authority.id IS NULL
        OR authority.organization_membership_id <> p_membership_id
      )
  ) THEN
    RAISE EXCEPTION 'personal workspace contains retained external document authority'
      USING ERRCODE = '55000';
  END IF;
  IF member.personal_workspace_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM workspace_captures capture
    WHERE capture.account_id = p_account_id
      AND capture.workspace_id = member.personal_workspace_id
      AND (
        pg_catalog.jsonb_typeof(capture.blob_keys) <> 'array'
        OR CASE WHEN pg_catalog.jsonb_typeof(capture.blob_keys) = 'array' THEN EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(capture.blob_keys) blob(value)
            WHERE pg_catalog.jsonb_typeof(blob.value) <> 'string'
              OR octet_length(convert_to(blob.value #>> '{}', 'UTF8')) NOT BETWEEN 1 AND 4096
          ) ELSE false END
      )
  ) THEN
    RAISE EXCEPTION 'personal workspace contains malformed external object inventory'
      USING ERRCODE = '55000';
  END IF;
  SELECT authority.resource_kind INTO unsupported_kind
  FROM organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind NOT IN (
      'claude_subscription', 'codex_subscription', 'connected_machine', 'connection', 'document',
      'rig', 'subscription_connection', 'variable_set', 'xai_subscription'
    )
  ORDER BY authority.resource_kind LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'unsupported retained resource kind: %%', unsupported_kind
      USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
  ORDER BY authority.id FOR UPDATE;
  SELECT COALESCE(array_agg(candidate.file_id ORDER BY candidate.file_id), ARRAY[]::uuid[])
  INTO candidate_file_ids
  FROM opengeni_private.organization_retention_file_candidates(
    p_account_id, p_membership_id
  ) candidate;
  PERFORM 1 FROM files file
  WHERE file.account_id = p_account_id AND file.id = ANY(candidate_file_ids)
  ORDER BY file.id FOR UPDATE;
  IF EXISTS (
    SELECT 1
    FROM opengeni_private.organization_retention_file_candidates(
      p_account_id, p_membership_id
    ) candidate
    WHERE candidate.object_bucket IS DISTINCT FROM p_object_bucket
  ) THEN
    RAISE EXCEPTION 'retention file bucket differs from configured object storage'
      USING ERRCODE = '55000';
  END IF;
  -- Freeze every external-key source before materializing obligations. The
  -- workspace row above excludes new FK children; these row locks exclude key
  -- rotation while exact obligations are copied and the workspace is erased.
  PERFORM 1 FROM session_recordings recording
  WHERE recording.account_id = p_account_id
    AND recording.workspace_id = member.personal_workspace_id
  ORDER BY recording.id FOR UPDATE;
  PERFORM 1 FROM browser_state_artifacts artifact
  WHERE artifact.account_id = p_account_id
    AND artifact.workspace_id = member.personal_workspace_id
  ORDER BY artifact.id FOR UPDATE;
  PERFORM 1 FROM browser_state_uploads upload
  WHERE upload.account_id = p_account_id
    AND upload.workspace_id = member.personal_workspace_id
  ORDER BY upload.id FOR UPDATE;
  PERFORM 1 FROM video_generation_references reference
  WHERE reference.account_id = p_account_id
    AND reference.workspace_id = member.personal_workspace_id
  ORDER BY reference.operation_id, reference.ordinal FOR UPDATE;
  PERFORM 1 FROM workspace_artifact_versions version
  WHERE version.account_id = p_account_id
    AND version.workspace_id = member.personal_workspace_id
  ORDER BY version.id FOR UPDATE;
  PERFORM 1 FROM editable_artifact_blob_refs blob
  WHERE blob.account_id = p_account_id
    AND blob.workspace_id = member.personal_workspace_id
  ORDER BY blob.artifact_id, blob.id FOR UPDATE;
  PERFORM 1 FROM workspace_captures capture
  WHERE capture.account_id = p_account_id
    AND capture.workspace_id = member.personal_workspace_id
  ORDER BY capture.id FOR UPDATE;
  INSERT INTO organization_user_retention_object_obligations (
    account_id, membership_id, object_kind, source_id, object_bucket, object_key,
    prepared_operation_id, object_key_hash
  )
  SELECT p_account_id, p_membership_id, candidate.object_kind,
    candidate.source_id, p_object_bucket, candidate.object_key, p_operation_id,
    encode(digest(candidate.object_key, 'sha256'), 'hex')
  FROM opengeni_private.organization_retention_object_candidates(
    p_account_id, p_membership_id
  ) candidate;
  GET DIAGNOSTICS object_count = ROW_COUNT;

  DELETE FROM documents document
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'document'
    AND authority.resource_id = document.id
    AND document.account_id = authority.account_id
    AND document.authority_id = authority.id
    AND document.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_documents = ROW_COUNT;
  DELETE FROM files file
  WHERE file.account_id = p_account_id AND file.id = ANY(candidate_file_ids)
    AND NOT EXISTS (SELECT 1 FROM documents document WHERE document.file_id = file.id);
  GET DIAGNOSTICS deleted_files = ROW_COUNT;

  deleted_variable_sets := 0;

  UPDATE capability_facet_installations binding SET connection_id = NULL,
    status = 'needs_attention',
    attention_code = 'owner_retention_deleted',
    version = version + 1, updated_at = clock_timestamp()
  WHERE binding.account_id = p_account_id AND binding.connection_id IN (
    SELECT authority.resource_id FROM organization_user_resource_authorities authority
    WHERE authority.account_id = p_account_id
      AND authority.organization_membership_id = p_membership_id
      AND authority.resource_kind = 'connection'
  );
  UPDATE integration_facet_bindings binding SET connection_id = NULL,
    status = 'needs_attention',
    last_error_code = 'owner_retention_deleted',
    version = version + 1, updated_at = clock_timestamp()
  WHERE binding.account_id = p_account_id AND binding.connection_id IN (
    SELECT authority.resource_id FROM organization_user_resource_authorities authority
    WHERE authority.account_id = p_account_id
      AND authority.organization_membership_id = p_membership_id
      AND authority.resource_kind = 'connection'
  );
  DELETE FROM connections resource
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'connection'
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_connections = ROW_COUNT;

  DELETE FROM subscription_connections resource
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'subscription_connection'
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_subscriptions = ROW_COUNT;

  DELETE FROM rigs resource
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'rig'
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_rigs = ROW_COUNT;

  UPDATE enrollments resource SET status = 'revoked',
    revoked_at = COALESCE(resource.revoked_at, clock_timestamp()),
    generation = resource.generation + 1, connection_instance_id = NULL,
    connection_lease_expires_at = NULL, desktop_unavailable_reason = NULL,
    updated_at = clock_timestamp()
  FROM organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'connected_machine'
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS tombstoned_machines = ROW_COUNT;

  UPDATE organization_user_resource_authorities authority
  SET status = 'revoked', revoked_at = COALESCE(authority.revoked_at, clock_timestamp()),
    generation = authority.generation + 1, updated_at = clock_timestamp()
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.status <> 'revoked';
  UPDATE organization_memberships membership
  SET personal_workspace_id = NULL, updated_at = clock_timestamp()
  WHERE membership.account_id = p_account_id AND membership.id = p_membership_id;
  IF member.personal_workspace_id IS NOT NULL THEN
    DELETE FROM workspaces workspace
    WHERE workspace.account_id = p_account_id AND workspace.id = member.personal_workspace_id;
    GET DIAGNOSTICS deleted_workspace = ROW_COUNT;
  END IF;
  result_value := pg_catalog.jsonb_build_object(
    'organizationId', p_account_id,
    'membershipId', p_membership_id,
    'operationId', p_operation_id,
    'outcome', 'cleanup_pending',
    'objectBucket', p_object_bucket,
    'objectCount', object_count,
    'deletedResources', pg_catalog.jsonb_build_object(
      'documents', deleted_documents, 'files', deleted_files,
      'variableSets', deleted_variable_sets, 'rigs', deleted_rigs,
      'connections', deleted_connections, 'codexSubscriptions', deleted_codex,
      'xaiSubscriptions', deleted_xai, 'claudeSubscriptions', deleted_claude,
      'subscriptionConnections', deleted_subscriptions, 'connectedMachinesTombstoned', tombstoned_machines,
      'personalWorkspaces', deleted_workspace
    ),
    'databaseFinalizedAt', clock_timestamp()
  );
  UPDATE organization_user_retention_deletions current_deletion
  SET database_result = result_value, database_finalized_at = clock_timestamp(),
    claim_expires_at = clock_timestamp() + interval '15 minutes',
    updated_at = clock_timestamp()
  WHERE current_deletion.account_id = p_account_id
    AND current_deletion.membership_id = p_membership_id
    AND current_deletion.claim_operation_id = p_operation_id;
  RETURN result_value;
END
$function$

$create$, data_schema);
END
$install$;

-- Membership-retention obligations and deletion receipts remain independent,
-- immutable evidence, including any existing legacy object-kind receipts.
DROP TABLE transcription_recording_chunks, transcription_recording_segments,
  transcription_recording_objects, transcription_recordings RESTRICT;
DROP FUNCTION opengeni_private.claim_due_transcription_recording_object_cleanup(bigint,bigint,integer) RESTRICT;
DROP FUNCTION opengeni_private.purge_expired_transcription_recordings(bigint,integer) RESTRICT;
