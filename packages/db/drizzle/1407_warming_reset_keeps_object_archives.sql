-- deployment-mode: rolling
-- An expired warming lease keeps its object-storage workspace archive.
--
-- When the worker creating and restoring a cold lease's box dies before the
-- provider returns an instance, the global lease reaper turns the expired
-- WARMING lease back to COLD and rebuilds its resume state with
-- warming_reset_resume_state_v2. That routine only recognised archives held
-- inline (sessionState.workspaceArchive / workspaceArchivePrev). Portable tar
-- archives live in object storage and are referenced through
-- workspaceArchiveRef / workspaceArchivePrevRef with no inline bytes, so for
-- them it returned NULL: the reset erased the archive pointer, and the next
-- turn saw an ordinary new lease and silently created an empty workspace while
-- the saved archive object was still intact.
--
-- Same signature and grants. The routine now matches the workspace-scoped
-- reaper's reset (archiveOnlyResumeState / warmingResetResumeState in
-- packages/db): an archive is present when it is held inline or through a
-- well-formed object reference; it keeps every archive slot (an inline copy
-- is dropped when its object reference exists, as everywhere else), the
-- historical, automatic-checkpoint, fresh-workspace and recovery-request
-- markers and the provider-loss record. The restore is pending only for a
-- complete current archive (descriptor present, archive generation equal to
-- the workspace generation, not abandoned); otherwise it is degraded. A lease
-- that records a published archive generation but whose archive pointer is
-- missing fails closed as unrecoverable (archive_unavailable), so the next
-- turn is blocked visibly instead of starting on an empty workspace. Only a
-- lease that never had an archive or recovery state still resets to NULL.
--
-- reap_sandbox_leases still clears resume_backend_id for object-only
-- archives. That column only names the provider of provider-native archives;
-- an object archive is a portable tar restored on whichever backend the next
-- acquire elects, and resume_state.backendId keeps the previous backend.
--
-- Rolling: the previous release calls the same routine through
-- reap_sandbox_leases and reads the resulting resume state with the same
-- parser it already uses for the workspace-scoped reaper's resets.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION opengeni_private.warming_reset_resume_state_v2(p_backend text, p_resume_backend_id text, p_resume_state jsonb, p_workspace_generation integer, p_archive_generation integer, p_reset_at timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  resume jsonb := CASE
    WHEN pg_catalog.jsonb_typeof(p_resume_state) = 'object' THEN p_resume_state
    ELSE '{}'::jsonb
  END;
  archive_session jsonb;
  durable_session jsonb := '{}'::jsonb;
  slot text;
  ref jsonb;
  ref_valid boolean;
  current_ref_valid boolean := false;
  previous_ref_valid boolean := false;
  current_present boolean;
  previous_present boolean;
  current_meta jsonb;
  previous_meta jsonb;
  archive_status text;
  has_archive boolean;
  fresh jsonb;
  fresh_valid boolean;
  fresh_pending boolean := false;
  fresh_retained boolean := false;
  provider_loss jsonb;
  abandoned boolean := false;
  complete boolean;
  restore_status text;
  reset_at jsonb := pg_catalog.to_jsonb(p_reset_at);
BEGIN
  archive_session := CASE
    WHEN pg_catalog.jsonb_typeof(resume -> 'sessionState') = 'object'
    THEN resume -> 'sessionState'
    ELSE '{}'::jsonb
  END;

  -- parseWorkspaceArchiveObjectRef in @opengeni/contracts.
  FOREACH slot IN ARRAY ARRAY['workspaceArchiveRef', 'workspaceArchivePrevRef'] LOOP
    ref := archive_session -> slot;
    ref_valid := pg_catalog.jsonb_typeof(ref) = 'object'
      AND pg_catalog.jsonb_typeof(ref -> 'schema') = 'string'
      AND ref ->> 'schema' = 'sandbox_archive_object_v1'
      AND pg_catalog.jsonb_typeof(ref -> 'key') = 'string'
      AND (ref ->> 'key') ~* ('^sandbox-archives/v1/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/'
        || 'wa1:[0-9]{13}:[0-9a-f]{64}'
        || '(\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?\.tar$')
      AND pg_catalog.jsonb_typeof(ref -> 'sha256') = 'string'
      AND (ref ->> 'sha256') ~ '^[a-f0-9]{64}$'
      AND pg_catalog.jsonb_typeof(ref -> 'bytes') = 'number'
      AND (ref ->> 'bytes')::numeric > 0
      AND (ref ->> 'bytes')::numeric <= 9007199254740991
      AND (ref ->> 'bytes')::numeric = pg_catalog.trunc((ref ->> 'bytes')::numeric)
      AND pg_catalog.jsonb_typeof(ref -> 'backend') = 'string'
      AND pg_catalog.length(ref ->> 'backend') BETWEEN 1 AND 64;
    IF slot = 'workspaceArchiveRef' THEN
      current_ref_valid := coalesce(ref_valid, false);
    ELSE
      previous_ref_valid := coalesce(ref_valid, false);
    END IF;
  END LOOP;

  current_present := current_ref_valid OR (
    pg_catalog.jsonb_typeof(archive_session -> 'workspaceArchive') = 'string'
    AND archive_session ->> 'workspaceArchive' <> ''
  );
  previous_present := previous_ref_valid OR (
    pg_catalog.jsonb_typeof(archive_session -> 'workspaceArchivePrev') = 'string'
    AND archive_session ->> 'workspaceArchivePrev' <> ''
  );
  current_meta := CASE
    WHEN pg_catalog.jsonb_typeof(archive_session -> 'workspaceArchiveMeta') = 'object'
      AND pg_catalog.jsonb_typeof(archive_session #> '{workspaceArchiveMeta,revision}') = 'string'
    THEN archive_session -> 'workspaceArchiveMeta'
  END;
  previous_meta := CASE
    WHEN pg_catalog.jsonb_typeof(archive_session -> 'workspaceArchivePrevMeta') = 'object'
      AND pg_catalog.jsonb_typeof(archive_session #> '{workspaceArchivePrevMeta,revision}') = 'string'
    THEN archive_session -> 'workspaceArchivePrevMeta'
  END;
  archive_status := CASE
    WHEN current_present AND current_meta IS NOT NULL THEN 'available'
    WHEN current_present OR previous_present THEN 'unverified'
    ELSE 'none'
  END;
  has_archive := archive_status <> 'none';

  -- Every durable archive slot; never the dead box's provider state.
  FOREACH slot IN ARRAY ARRAY[
    'workspaceArchive', 'workspaceArchiveMeta', 'workspaceArchiveRef',
    'workspaceArchivePrev', 'workspaceArchivePrevMeta', 'workspaceArchivePrevRef',
    'workspaceArchiveAt'
  ] LOOP
    IF coalesce(pg_catalog.jsonb_typeof(archive_session -> slot), 'null') <> 'null' THEN
      durable_session := durable_session
        || pg_catalog.jsonb_build_object(slot, archive_session -> slot);
    END IF;
  END LOOP;
  IF current_ref_valid THEN
    durable_session := durable_session - 'workspaceArchive';
  END IF;
  IF previous_ref_valid THEN
    durable_session := durable_session - 'workspaceArchivePrev';
  END IF;

  fresh := resume -> 'opengeniFreshWorkspaceRecovery';
  fresh_valid := pg_catalog.jsonb_typeof(fresh) = 'object'
    AND fresh -> 'version' = '1'::jsonb
    AND pg_catalog.jsonb_typeof(fresh -> 'operationId') = 'string'
    AND (fresh ->> 'operationId')
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND pg_catalog.jsonb_typeof(fresh -> 'sessionId') = 'string'
    AND fresh ->> 'status' IN ('accepted', 'verified')
    AND pg_catalog.jsonb_typeof(fresh -> 'authorizedAt') = 'string';
  IF coalesce(fresh_valid, false) THEN
    fresh_pending := fresh ->> 'status' = 'accepted';
    fresh_retained := fresh_pending
      OR pg_catalog.jsonb_typeof(fresh -> 'abandonedRevision') = 'string';
    abandoned := pg_catalog.jsonb_typeof(fresh -> 'abandonedRevision') = 'string'
      AND fresh ->> 'abandonedRevision' = current_meta ->> 'revision';
  END IF;
  provider_loss := CASE
    WHEN pg_catalog.jsonb_typeof(resume -> 'opengeniProviderLoss') = 'object'
      AND resume #> '{opengeniProviderLoss,version}' = '1'::jsonb
    THEN resume -> 'opengeniProviderLoss'
  END;

  -- A lease that never had an archive or any recovery state starts over as a
  -- new lease. A recorded archive generation means one was published.
  IF NOT has_archive AND NOT fresh_pending AND provider_loss IS NULL
    AND p_archive_generation IS NULL THEN
    RETURN NULL;
  END IF;

  complete := archive_status = 'available'
    AND NOT coalesce(abandoned, false)
    AND p_archive_generation IS NOT NULL
    AND p_workspace_generation >= 0
    AND p_archive_generation = p_workspace_generation;
  restore_status := CASE
    WHEN complete THEN 'pending'
    WHEN has_archive THEN 'degraded'
    ELSE 'unrecoverable'
  END;

  RETURN pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'backendId', coalesce(
      CASE WHEN pg_catalog.jsonb_typeof(resume -> 'backendId') = 'string'
        THEN resume ->> 'backendId' END,
      p_resume_backend_id,
      p_backend
    ),
    'sessionState', CASE WHEN durable_session <> '{}'::jsonb THEN durable_session END,
    'opengeniHistoricalArchiveRecoveryId', CASE
      WHEN pg_catalog.jsonb_typeof(resume -> 'opengeniHistoricalArchiveRecoveryId') = 'string'
      THEN resume -> 'opengeniHistoricalArchiveRecoveryId' END,
    'opengeniAutomaticCheckpointRecovery', CASE
      WHEN pg_catalog.jsonb_typeof(resume -> 'opengeniAutomaticCheckpointRecovery')
        IN ('object', 'array')
      THEN resume -> 'opengeniAutomaticCheckpointRecovery' END,
    'opengeniFreshWorkspaceRecovery', CASE WHEN fresh_retained THEN fresh END,
    'opengeniWorkspaceRecoveryRequest', CASE
      WHEN coalesce(pg_catalog.jsonb_typeof(resume -> 'opengeniWorkspaceRecoveryRequest'), 'null')
        NOT IN ('null', 'boolean')
      THEN resume -> 'opengeniWorkspaceRecoveryRequest' END,
    'opengeniProviderLoss', provider_loss
  )) || pg_catalog.jsonb_build_object(
    'opengeniRecovery', pg_catalog.jsonb_build_object(
      'provider', pg_catalog.jsonb_build_object(
        'status', 'not_created', 'instanceId', null, 'observedAt', reset_at
      ),
      'archive', pg_catalog.jsonb_build_object(
        'status', archive_status,
        'current', current_meta,
        'previous', previous_meta
      ),
      'restore', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'status', restore_status,
        'completedAt', reset_at,
        'failureCode', CASE restore_status
          WHEN 'degraded' THEN CASE archive_status
            WHEN 'available' THEN 'archive_generation_mismatch'
            ELSE 'archive_unverified' END
          WHEN 'unrecoverable' THEN 'archive_unavailable'
        END,
        'retryable', CASE WHEN restore_status <> 'pending' THEN pg_catalog.to_jsonb(false) END
      )) || pg_catalog.jsonb_build_object(
        'rematerializationId', null,
        'selectedRevision', current_meta -> 'revision',
        'startedAt', null
      ),
      'workspace', pg_catalog.jsonb_build_object(
        'status', CASE restore_status
          WHEN 'pending' THEN 'not_ready'
          WHEN 'degraded' THEN 'degraded'
          ELSE 'unrecoverable' END,
        'verifiedRevision', null,
        'verifiedAt', null
      )
    )
  );
END;
$$;
