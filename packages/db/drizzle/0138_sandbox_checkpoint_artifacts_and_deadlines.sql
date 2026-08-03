-- deployment-mode: maintenance
-- Make provider snapshot ownership and finite sandbox lifetime first-class
-- durable state. This is a one-way protocol cutover: old application workers
-- neither stamp provider deadlines nor honor rotation fences, so every
-- opengeni_app session must be stopped before this migration runs.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';

-- Reject an obviously live old application before waiting on table locks. The
-- guard runs again after the locks to close the connect/write race.
DO $maintenance_preflight_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'sandbox checkpoint/deadline activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$maintenance_preflight_guard$;

-- Serialize the cutover against every old lease lifecycle writer. The migration
-- runner wraps this file in one transaction, so any timeout/guard failure leaves
-- the old schema and protocol fully active.
LOCK TABLE sandbox_leases IN ACCESS EXCLUSIVE MODE;
LOCK TABLE sandbox_lease_holders IN ACCESS EXCLUSIVE MODE;
LOCK TABLE sandbox_pty_sessions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE sandbox_retained_processes IN ACCESS EXCLUSIVE MODE;
LOCK TABLE sandbox_workspace_mutation_admissions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE session_turn_attempts IN SHARE MODE;
LOCK TABLE session_turns IN SHARE MODE;

DO $maintenance_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'sandbox checkpoint/deadline activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$maintenance_guard$;

-- A provider establish call can outlive an abandoned Temporal activity. Older
-- workers kept touching the resulting holder from a private warmup timer even
-- after the exact attempt had closed, so TTL cleanup could never observe it as
-- stale. The maintenance fence makes this a race-free one-time reconciliation:
-- retain only canonical turn holders whose complete attempt/turn ownership
-- chain is still current, then restore the lease counters from source rows.
WITH removed AS MATERIALIZED (
  DELETE FROM sandbox_lease_holders holder
  WHERE holder.kind = 'turn'
    AND holder.holder_id
      ~* '^turn-attempt:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND NOT EXISTS (
      SELECT 1
      FROM session_turn_attempts attempt
      JOIN session_turns turn
        ON turn.account_id = attempt.account_id
       AND turn.workspace_id = attempt.workspace_id
       AND turn.session_id = attempt.session_id
       AND turn.id = attempt.turn_id
       AND turn.execution_generation = attempt.execution_generation
       AND turn.active_attempt_id = attempt.id
      WHERE holder.holder_id = ('turn-attempt:' || attempt.id::text)
        AND attempt.account_id = holder.account_id
        AND attempt.workspace_id = holder.workspace_id
        AND attempt.session_id = holder.subject_id
        AND attempt.state IN ('claimed', 'running')
    )
  RETURNING holder.id AS holder_id, holder.lease_id
),
affected AS MATERIALIZED (
  SELECT DISTINCT removed.lease_id AS id FROM removed
),
-- Data-modifying CTE siblings share one base-table snapshot in PostgreSQL.
-- The physical DELETE is therefore not visible to these counts; subtract its
-- exact RETURNING identities explicitly instead of silently retaining stale
-- denormalized counters.
counts AS MATERIALIZED (
  SELECT affected.id,
    (SELECT count(*) FROM sandbox_lease_holders holder
      WHERE holder.lease_id = affected.id
        AND NOT EXISTS (
          SELECT 1 FROM removed WHERE removed.holder_id = holder.id
        ))::integer AS total,
    (SELECT count(*) FROM sandbox_lease_holders holder
      WHERE holder.lease_id = affected.id
        AND holder.kind = 'turn'
        AND NOT EXISTS (
          SELECT 1 FROM removed WHERE removed.holder_id = holder.id
        ))::integer AS turns,
    (SELECT count(*) FROM sandbox_lease_holders holder
      WHERE holder.lease_id = affected.id
        AND holder.kind = 'viewer'
        AND NOT EXISTS (
          SELECT 1 FROM removed WHERE removed.holder_id = holder.id
        ))::integer AS viewers
  FROM affected
)
UPDATE sandbox_leases lease SET
  refcount = counts.total,
  turn_holders = counts.turns,
  viewer_holders = counts.viewers,
  liveness = CASE
    WHEN lease.liveness = 'warm' AND counts.total = 0 THEN 'draining'
    ELSE lease.liveness
  END,
  expires_at = CASE
    WHEN lease.liveness = 'warm' AND counts.total = 0
    THEN now() - interval '1 millisecond'
    ELSE lease.expires_at
  END,
  updated_at = now()
FROM counts
WHERE lease.id = counts.id;

-- A provider instance may disappear after its lease row has already advanced
-- to a successor identity. The reconciliation worker can still prove the exact
-- historical Modal sandbox is terminal by id; persist that distinct proof
-- instead of retrying an impossible current-lease identity match forever.
ALTER TABLE sandbox_retained_processes
  ADD COLUMN provider_binding_key text,
  ADD COLUMN provider_binding jsonb,
  DROP CONSTRAINT sandbox_retained_processes_reconcile_proof_check,
  ADD CONSTRAINT sandbox_retained_processes_provider_binding_check
  CHECK (
    (
      provider_binding_key IS NULL
      AND provider_binding IS NULL
    ) OR (
      provider_backend = 'modal'
      AND octet_length(provider_binding_key) BETWEEN 1 AND 1024
      AND jsonb_typeof(provider_binding) = 'object'
      AND provider_binding_key::jsonb = provider_binding
      AND provider_binding_key = format(
        '{"version":1,"serverUrl":%s,"workspaceName":%s,"environment":%s}',
        to_jsonb(provider_binding ->> 'serverUrl')::text,
        to_jsonb(provider_binding ->> 'workspaceName')::text,
        to_jsonb(provider_binding ->> 'environment')::text
      )
      AND provider_binding = jsonb_build_object(
        'version', 1,
        'serverUrl', provider_binding ->> 'serverUrl',
        'workspaceName', provider_binding ->> 'workspaceName',
        'environment', provider_binding ->> 'environment'
      )
      AND coalesce(octet_length(provider_binding ->> 'serverUrl'), 0) > 0
      AND coalesce(octet_length(provider_binding ->> 'workspaceName'), 0) > 0
      AND provider_binding ->> 'environment' IS NOT NULL
    )
  ),
  ADD CONSTRAINT sandbox_retained_processes_reconcile_proof_check
  CHECK (
    (
      reconcile_proof_outcome IS NULL
      AND reconcile_proof_exit_code IS NULL
      AND reconcile_proof_reason IS NULL
      AND reconcile_proof_observed_at IS NULL
    ) OR (
      reconcile_proof_outcome = 'exited'
      AND reconcile_proof_exit_code IS NOT NULL
      AND reconcile_proof_reason = 'provider_exit_banner'
      AND reconcile_proof_observed_at IS NOT NULL
    ) OR (
      reconcile_proof_outcome = 'lost'
      AND reconcile_proof_exit_code IS NULL
      AND reconcile_proof_reason IN (
        'provider_session_lost_banner',
        'provider_instance_not_found',
        'provider_instance_terminated'
      )
      AND reconcile_proof_observed_at IS NOT NULL
    )
  );

CREATE TABLE sandbox_checkpoint_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  sandbox_group_id uuid NOT NULL,
  source_lease_id uuid NOT NULL,
  source_lease_epoch integer NOT NULL,
  source_instance_id text,
  source_workspace_generation integer,
  provenance text NOT NULL,
  provider_backend text NOT NULL,
  provider_binding_key text NOT NULL,
  provider_binding jsonb NOT NULL,
  object_kind text NOT NULL,
  object_id text NOT NULL,
  archive_base64 text NOT NULL,
  archive_sha256 text NOT NULL,
  archive_bytes integer NOT NULL,
  descriptor jsonb NOT NULL,
  descriptor_revision text NOT NULL,
  state text NOT NULL DEFAULT 'candidate',
  delete_after timestamptz,
  delete_attempts integer NOT NULL DEFAULT 0,
  delete_claim_id uuid,
  delete_claimed_at timestamptz,
  last_delete_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sandbox_checkpoint_artifacts_source_check CHECK (
    source_lease_epoch >= 0
    AND (
      (
        provenance = 'native_capture'
        AND source_workspace_generation IS NOT NULL
        AND source_workspace_generation >= 0
        AND source_instance_id IS NOT NULL
        AND octet_length(source_instance_id) BETWEEN 1 AND 512
      )
      OR (
        provenance = 'legacy_provider_adopted'
        AND source_workspace_generation IS NULL
        AND source_instance_id IS NULL
      )
    )
  ),
  CONSTRAINT sandbox_checkpoint_artifacts_provider_check CHECK (
    provider_backend = 'modal'
    AND octet_length(provider_binding_key) BETWEEN 1 AND 1024
    AND jsonb_typeof(provider_binding) = 'object'
    AND provider_binding_key::jsonb = provider_binding
    AND provider_binding_key = format(
      '{"version":1,"serverUrl":%s,"workspaceName":%s,"environment":%s}',
      to_jsonb(provider_binding ->> 'serverUrl')::text,
      to_jsonb(provider_binding ->> 'workspaceName')::text,
      to_jsonb(provider_binding ->> 'environment')::text
    )
    AND provider_binding = jsonb_build_object(
      'version', 1,
      'serverUrl', provider_binding ->> 'serverUrl',
      'workspaceName', provider_binding ->> 'workspaceName',
      'environment', provider_binding ->> 'environment'
    )
    AND coalesce(octet_length(provider_binding ->> 'serverUrl'), 0) > 0
    AND coalesce(octet_length(provider_binding ->> 'workspaceName'), 0) > 0
    AND provider_binding ->> 'environment' IS NOT NULL
    AND object_kind IN ('modal_filesystem_snapshot', 'modal_directory_snapshot')
    AND octet_length(object_id) BETWEEN 1 AND 1024
  ),
  CONSTRAINT sandbox_checkpoint_artifacts_archive_check CHECK (
    archive_bytes > 0
    AND octet_length(archive_base64) > 0
    AND archive_sha256 ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(descriptor) = 'object'
    AND octet_length(descriptor_revision) BETWEEN 1 AND 256
    AND translate(encode(decode(archive_base64, 'base64'), 'base64'), E'\n\r', '')
      = archive_base64
    AND octet_length(decode(archive_base64, 'base64')) = archive_bytes
    AND encode(digest(decode(archive_base64, 'base64'), 'sha256'), 'hex')
      = archive_sha256
    AND descriptor ->> 'version' = '2'
    AND descriptor ->> 'kind' = 'provider_snapshot'
    AND descriptor ->> 'revision' = descriptor_revision
    AND descriptor ->> 'archiveSha256' = archive_sha256
    AND CASE
      WHEN descriptor ->> 'archiveBytes' ~ '^[1-9][0-9]*$'
      THEN (descriptor ->> 'archiveBytes')::bigint = archive_bytes
      ELSE false
    END
    AND descriptor ->> 'snapshotId' = object_id
    AND (
      (
        object_kind = 'modal_filesystem_snapshot'
        AND descriptor ->> 'provider' = 'modal_snapshot_filesystem'
        AND descriptor ->> 'workspacePersistence' = 'snapshot_filesystem'
      )
      OR (
        object_kind = 'modal_directory_snapshot'
        AND descriptor ->> 'provider' = 'modal_snapshot_directory'
        AND descriptor ->> 'workspacePersistence' = 'snapshot_directory'
      )
    )
  ),
  CONSTRAINT sandbox_checkpoint_artifacts_state_check CHECK (
    state IN (
      'candidate', 'current', 'previous', 'delete_pending',
      'deleting', 'delete_failed', 'deleted'
    )
  ),
  CONSTRAINT sandbox_checkpoint_artifacts_delete_claim_check CHECK (
    (state = 'deleting' AND delete_claim_id IS NOT NULL AND delete_claimed_at IS NOT NULL)
    OR (state <> 'deleting' AND delete_claim_id IS NULL AND delete_claimed_at IS NULL)
  )
);

CREATE UNIQUE INDEX sandbox_checkpoint_artifacts_provider_object_uq
  ON sandbox_checkpoint_artifacts (provider_backend, provider_binding_key, object_id);
CREATE INDEX sandbox_checkpoint_artifacts_gc_idx
  ON sandbox_checkpoint_artifacts (delete_after, created_at, id)
  WHERE state IN (
    'candidate', 'current', 'previous',
    'delete_pending', 'delete_failed', 'deleting'
  );
CREATE INDEX sandbox_checkpoint_artifacts_source_idx
  ON sandbox_checkpoint_artifacts (workspace_id, sandbox_group_id, source_lease_id);

ALTER TABLE sandbox_leases
  ADD COLUMN provider_created_at timestamptz,
  ADD COLUMN provider_deadline_at timestamptz,
  ADD COLUMN rotation_requested_at timestamptz,
  ADD COLUMN rotation_reason text,
  ADD COLUMN current_checkpoint_artifact_id uuid,
  ADD COLUMN previous_checkpoint_artifact_id uuid;

ALTER TABLE sandbox_leases
  ADD CONSTRAINT sandbox_leases_provider_deadline_check CHECK (
    (provider_created_at IS NULL AND provider_deadline_at IS NULL)
    OR (
      provider_created_at IS NOT NULL
      AND provider_deadline_at IS NOT NULL
      AND provider_deadline_at > provider_created_at
    )
  ),
  ADD CONSTRAINT sandbox_leases_rotation_check CHECK (
    (rotation_requested_at IS NULL AND rotation_reason IS NULL)
    OR (
      rotation_requested_at IS NOT NULL
      AND rotation_reason IN ('provider_deadline', 'operator')
    )
  ),
  ADD CONSTRAINT sandbox_leases_checkpoint_distinct_check CHECK (
    current_checkpoint_artifact_id IS NULL
    OR previous_checkpoint_artifact_id IS NULL
    OR current_checkpoint_artifact_id <> previous_checkpoint_artifact_id
  ),
  ADD CONSTRAINT sandbox_leases_current_checkpoint_fk
    FOREIGN KEY (current_checkpoint_artifact_id)
    REFERENCES sandbox_checkpoint_artifacts (id)
    DEFERRABLE INITIALLY IMMEDIATE,
  ADD CONSTRAINT sandbox_leases_previous_checkpoint_fk
    FOREIGN KEY (previous_checkpoint_artifact_id)
    REFERENCES sandbox_checkpoint_artifacts (id)
    DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX sandbox_leases_provider_deadline_idx
  ON sandbox_leases (provider_deadline_at, id)
  WHERE backend = 'modal'
    AND liveness IN ('warming', 'warm')
    AND rotation_requested_at IS NULL;

-- Publication validation is deferred so one transaction can register a
-- candidate, rotate both lease references, and update artifact states in any
-- convenient statement order while still rejecting cross-scope references.
DO $checkpoint_ref_validator$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.validate_sandbox_checkpoint_refs()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE checkpoint %1$I.sandbox_checkpoint_artifacts%%ROWTYPE;
    BEGIN
      IF NEW.current_checkpoint_artifact_id IS NOT NULL THEN
        SELECT * INTO checkpoint
        FROM %1$I.sandbox_checkpoint_artifacts
        WHERE id = NEW.current_checkpoint_artifact_id;
        IF NOT FOUND
          OR checkpoint.account_id <> NEW.account_id
          OR checkpoint.workspace_id <> NEW.workspace_id
          OR checkpoint.sandbox_group_id <> NEW.sandbox_group_id
          OR checkpoint.source_lease_id <> NEW.id
          OR checkpoint.provider_backend <> NEW.backend
          OR (
            checkpoint.provenance = 'native_capture'
            AND checkpoint.source_workspace_generation
              IS DISTINCT FROM NEW.archive_generation
          )
          OR (
            checkpoint.provenance = 'legacy_provider_adopted'
            AND NEW.archive_generation IS DISTINCT FROM NEW.workspace_generation
          )
          OR checkpoint.archive_base64
            IS DISTINCT FROM NEW.resume_state #>> '{sessionState,workspaceArchive}'
          OR checkpoint.descriptor_revision
            IS DISTINCT FROM NEW.resume_state #>> '{sessionState,workspaceArchiveMeta,revision}'
          OR checkpoint.state <> 'current'
        THEN
          RAISE EXCEPTION 'current checkpoint artifact does not match its exact lease scope'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      IF NEW.previous_checkpoint_artifact_id IS NOT NULL THEN
        SELECT * INTO checkpoint
        FROM %1$I.sandbox_checkpoint_artifacts
        WHERE id = NEW.previous_checkpoint_artifact_id;
        IF NOT FOUND
          OR checkpoint.account_id <> NEW.account_id
          OR checkpoint.workspace_id <> NEW.workspace_id
          OR checkpoint.sandbox_group_id <> NEW.sandbox_group_id
          OR checkpoint.source_lease_id <> NEW.id
          OR checkpoint.provider_backend <> NEW.backend
          OR checkpoint.archive_base64
            IS DISTINCT FROM NEW.resume_state #>> '{sessionState,workspaceArchivePrev}'
          OR checkpoint.descriptor_revision
            IS DISTINCT FROM NEW.resume_state #>> '{sessionState,workspaceArchivePrevMeta,revision}'
          OR checkpoint.state <> 'previous'
        THEN
          RAISE EXCEPTION 'previous checkpoint artifact does not match its exact lease scope'
            USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $function$;
  $create$, data_schema);
END
$checkpoint_ref_validator$;

DO $checkpoint_artifact_ref_validator$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.validate_sandbox_checkpoint_artifact_refs()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE exact_current boolean;
    DECLARE exact_previous boolean;
    DECLARE any_reference boolean;
    DECLARE final_state text;
    BEGIN
      SELECT artifact.state INTO final_state
      FROM %1$I.sandbox_checkpoint_artifacts artifact
      WHERE artifact.id = NEW.id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'checkpoint artifact vanished before reference validation'
          USING ERRCODE = '23514';
      END IF;

      SELECT
        pg_catalog.bool_or(
          lease.current_checkpoint_artifact_id = NEW.id
          AND lease.id = NEW.source_lease_id
          AND lease.account_id = NEW.account_id
          AND lease.workspace_id = NEW.workspace_id
          AND lease.sandbox_group_id = NEW.sandbox_group_id
          AND lease.backend = NEW.provider_backend
        ),
        pg_catalog.bool_or(
          lease.previous_checkpoint_artifact_id = NEW.id
          AND lease.id = NEW.source_lease_id
          AND lease.account_id = NEW.account_id
          AND lease.workspace_id = NEW.workspace_id
          AND lease.sandbox_group_id = NEW.sandbox_group_id
          AND lease.backend = NEW.provider_backend
        ),
        pg_catalog.bool_or(
          lease.current_checkpoint_artifact_id = NEW.id
          OR lease.previous_checkpoint_artifact_id = NEW.id
        )
      INTO exact_current, exact_previous, any_reference
      FROM %1$I.sandbox_leases lease
      WHERE lease.current_checkpoint_artifact_id = NEW.id
         OR lease.previous_checkpoint_artifact_id = NEW.id;

      exact_current := coalesce(exact_current, false);
      exact_previous := coalesce(exact_previous, false);
      any_reference := coalesce(any_reference, false);

      IF (final_state = 'current' AND (NOT exact_current OR exact_previous))
        OR (final_state = 'previous' AND (NOT exact_previous OR exact_current))
        OR (final_state NOT IN ('current', 'previous') AND any_reference)
      THEN
        RAISE EXCEPTION 'checkpoint artifact state does not match its exact lease reference'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $function$;
  $create$, data_schema);
END
$checkpoint_artifact_ref_validator$;

CREATE CONSTRAINT TRIGGER sandbox_checkpoint_refs_guard
AFTER INSERT OR UPDATE OF
  account_id, workspace_id, sandbox_group_id, backend,
  workspace_generation, archive_generation, resume_state,
  current_checkpoint_artifact_id, previous_checkpoint_artifact_id
ON sandbox_leases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_sandbox_checkpoint_refs();

CREATE CONSTRAINT TRIGGER sandbox_checkpoint_artifact_refs_guard
AFTER INSERT OR UPDATE OF
  account_id, workspace_id, sandbox_group_id, source_lease_id,
  provider_backend, state
ON sandbox_checkpoint_artifacts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_sandbox_checkpoint_artifact_refs();

CREATE OR REPLACE FUNCTION opengeni_private.enforce_sandbox_checkpoint_artifact_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF ROW(
    NEW.id, NEW.account_id, NEW.workspace_id, NEW.sandbox_group_id,
    NEW.source_lease_id, NEW.source_lease_epoch, NEW.source_instance_id,
    NEW.source_workspace_generation, NEW.provenance, NEW.provider_backend,
    NEW.provider_binding_key, NEW.provider_binding, NEW.object_kind,
    NEW.object_id, NEW.archive_base64, NEW.archive_sha256, NEW.archive_bytes,
    NEW.descriptor, NEW.descriptor_revision, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.account_id, OLD.workspace_id, OLD.sandbox_group_id,
    OLD.source_lease_id, OLD.source_lease_epoch, OLD.source_instance_id,
    OLD.source_workspace_generation, OLD.provenance, OLD.provider_backend,
    OLD.provider_binding_key, OLD.provider_binding, OLD.object_kind,
    OLD.object_id, OLD.archive_base64, OLD.archive_sha256, OLD.archive_bytes,
    OLD.descriptor, OLD.descriptor_revision, OLD.created_at
  )
  THEN
    RAISE EXCEPTION 'checkpoint artifact identity and receipt fields are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER sandbox_checkpoint_artifact_immutability_guard
BEFORE UPDATE ON sandbox_checkpoint_artifacts
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.enforce_sandbox_checkpoint_artifact_immutability();

CREATE TRIGGER sandbox_recovery_protocol_v2_checkpoint_guard
BEFORE INSERT OR UPDATE OR DELETE ON sandbox_checkpoint_artifacts
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v2();

ALTER TABLE sandbox_checkpoint_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_checkpoint_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON sandbox_checkpoint_artifacts
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

-- Cross-workspace claim. Candidates that were captured but never published are
-- collectible after a grace period. Referenced artifacts are never returned,
-- even if a corrupt/stale state label says otherwise.
DO $checkpoint_gc_functions$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.claim_sandbox_checkpoint_artifacts(
      p_claim_id uuid,
      p_limit integer,
      p_claim_ttl_ms bigint
    )
    RETURNS TABLE (
      id uuid,
      provider_backend text,
      provider_binding_key text,
      provider_binding jsonb,
      object_kind text,
      object_id text,
      delete_attempts integer
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF p_claim_id IS NULL THEN
        RAISE EXCEPTION 'checkpoint artifact claim id is required'
          USING ERRCODE = '22023';
      END IF;
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION 'checkpoint artifact claim limit must be between 1 and 500'
          USING ERRCODE = '22023';
      END IF;
      IF p_claim_ttl_ms IS NULL
        OR p_claim_ttl_ms < 1000
        OR p_claim_ttl_ms > 3600000
      THEN
        RAISE EXCEPTION 'checkpoint artifact claim TTL must be between 1s and 1h'
          USING ERRCODE = '22023';
      END IF;

      PERFORM pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);

      WITH stale_claims AS MATERIALIZED (
        SELECT artifact.id
        FROM %1$I.sandbox_checkpoint_artifacts artifact
        WHERE artifact.state = 'deleting'
          AND artifact.delete_claimed_at
            < pg_catalog.now()
              - pg_catalog.make_interval(secs => p_claim_ttl_ms / 1000.0)
        ORDER BY artifact.delete_claimed_at, artifact.id
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
      )
      UPDATE %1$I.sandbox_checkpoint_artifacts artifact SET
        state = 'delete_failed',
        delete_after = pg_catalog.now(),
        delete_claim_id = null,
        delete_claimed_at = null,
        last_delete_error = coalesce(
          last_delete_error, 'stale delete claim recovered'
        ),
        updated_at = pg_catalog.now()
      FROM stale_claims
      WHERE artifact.id = stale_claims.id;

      RETURN QUERY
      WITH candidates AS (
        SELECT artifact.id
        FROM %1$I.sandbox_checkpoint_artifacts artifact
        WHERE (
            (
              artifact.state = 'candidate'
              AND artifact.created_at < pg_catalog.now() - interval '15 minutes'
            )
            OR (
              artifact.state IN ('current', 'previous')
              AND artifact.created_at < pg_catalog.now() - interval '15 minutes'
            )
            OR (
              artifact.state IN ('delete_pending', 'delete_failed')
              AND coalesce(artifact.delete_after, artifact.created_at)
                <= pg_catalog.now()
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM %1$I.sandbox_leases lease
            WHERE lease.current_checkpoint_artifact_id = artifact.id
               OR lease.previous_checkpoint_artifact_id = artifact.id
          )
        ORDER BY coalesce(artifact.delete_after, artifact.created_at), artifact.id
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
      )
      UPDATE %1$I.sandbox_checkpoint_artifacts artifact SET
        state = 'deleting',
        delete_attempts = artifact.delete_attempts + 1,
        delete_claim_id = p_claim_id,
        delete_claimed_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
      FROM candidates
      WHERE artifact.id = candidates.id
      RETURNING artifact.id, artifact.provider_backend, artifact.provider_binding_key,
        artifact.provider_binding, artifact.object_kind, artifact.object_id,
        artifact.delete_attempts;
    END;
    $function$;
  $create$, data_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.settle_sandbox_checkpoint_artifact(
      p_id uuid,
      p_claim_id uuid,
      p_deleted boolean,
      p_error text,
      p_retry_after_ms bigint
    )
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE changed integer;
    BEGIN
      IF p_id IS NULL OR p_claim_id IS NULL THEN
        RAISE EXCEPTION 'checkpoint artifact and claim ids are required'
          USING ERRCODE = '22023';
      END IF;
      IF p_deleted IS NULL THEN
        RAISE EXCEPTION 'checkpoint artifact deletion outcome is required'
          USING ERRCODE = '22023';
      END IF;
      IF p_retry_after_ms IS NULL
        OR p_retry_after_ms < 0
        OR p_retry_after_ms > 86400000
      THEN
        RAISE EXCEPTION 'checkpoint artifact retry delay must be between 0 and 24h'
          USING ERRCODE = '22023';
      END IF;

      PERFORM pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);
      UPDATE %1$I.sandbox_checkpoint_artifacts SET
        state = CASE WHEN p_deleted THEN 'deleted' ELSE 'delete_failed' END,
        deleted_at = CASE WHEN p_deleted THEN pg_catalog.now() ELSE null END,
        delete_after = CASE
          WHEN p_deleted THEN null
          ELSE pg_catalog.now()
            + pg_catalog.make_interval(secs => greatest(1000, p_retry_after_ms) / 1000.0)
        END,
        delete_claim_id = null,
        delete_claimed_at = null,
        last_delete_error = CASE
          WHEN p_deleted THEN null
          ELSE pg_catalog.left(coalesce(p_error, 'unknown'), 4000)
        END,
        updated_at = pg_catalog.now()
      WHERE id = p_id
        AND state = 'deleting'
        AND delete_claim_id = p_claim_id;
      GET DIAGNOSTICS changed = ROW_COUNT;
      RETURN changed = 1;
    END;
    $function$;
  $create$, data_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.prune_deleted_sandbox_checkpoint_artifacts(
      p_retention_ms bigint,
      p_limit integer
    )
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE pruned integer;
    BEGIN
      IF p_retention_ms IS NULL
        OR p_retention_ms < 86400000
        OR p_retention_ms > 31536000000
      THEN
        RAISE EXCEPTION 'checkpoint tombstone retention must be between 1 and 365 days'
          USING ERRCODE = '22023';
      END IF;
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
        RAISE EXCEPTION 'checkpoint tombstone prune limit must be between 1 and 1000'
          USING ERRCODE = '22023';
      END IF;

      PERFORM pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);
      WITH candidates AS MATERIALIZED (
        SELECT artifact.id
        FROM %1$I.sandbox_checkpoint_artifacts artifact
        WHERE artifact.state = 'deleted'
          AND artifact.deleted_at
            < pg_catalog.now()
              - pg_catalog.make_interval(secs => p_retention_ms / 1000.0)
          AND NOT EXISTS (
            SELECT 1 FROM %1$I.sandbox_leases lease
            WHERE lease.current_checkpoint_artifact_id = artifact.id
               OR lease.previous_checkpoint_artifact_id = artifact.id
          )
        ORDER BY artifact.deleted_at, artifact.id
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
      ),
      removed AS (
        DELETE FROM %1$I.sandbox_checkpoint_artifacts artifact
        USING candidates
        WHERE artifact.id = candidates.id
        RETURNING artifact.id
      )
      SELECT pg_catalog.count(*)::integer INTO pruned FROM removed;
      RETURN pruned;
    END;
    $function$;
  $create$, data_schema);
END
$checkpoint_gc_functions$;

DO $checkpoint_legacy_and_rotation_functions$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.list_legacy_modal_checkpoint_slots(
      p_limit integer
    )
    RETURNS TABLE (
      account_id uuid,
      workspace_id uuid,
      sandbox_group_id uuid,
      lease_id uuid,
      lease_epoch integer,
      instance_id text,
      workspace_generation integer,
      slot text,
      archive_base64 text,
      descriptor jsonb
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION 'legacy checkpoint slot limit must be between 1 and 500'
          USING ERRCODE = '22023';
      END IF;

      RETURN QUERY
        SELECT lease.account_id, lease.workspace_id, lease.sandbox_group_id, lease.id,
          lease.lease_epoch, lease.instance_id,
          lease.workspace_generation, candidate.slot, candidate.archive_base64,
          candidate.descriptor
        FROM %1$I.sandbox_leases lease
        CROSS JOIN LATERAL (
          VALUES
            (
              'current'::text,
              lease.resume_state #>> '{sessionState,workspaceArchive}',
              lease.resume_state #> '{sessionState,workspaceArchiveMeta}',
              lease.current_checkpoint_artifact_id
            ),
            (
              'previous'::text,
              lease.resume_state #>> '{sessionState,workspaceArchivePrev}',
              lease.resume_state #> '{sessionState,workspaceArchivePrevMeta}',
              lease.previous_checkpoint_artifact_id
            )
        ) candidate(slot, archive_base64, descriptor, artifact_id)
        WHERE candidate.artifact_id IS NULL
          AND lease.backend = 'modal'
          AND lease.liveness IN ('warming', 'warm', 'draining')
          AND lease.instance_id IS NOT NULL
          AND coalesce(candidate.archive_base64, '') <> ''
          AND candidate.descriptor ->> 'version' = '2'
          AND candidate.descriptor ->> 'provider'
            IN ('modal_snapshot_filesystem', 'modal_snapshot_directory')
        ORDER BY lease.updated_at, lease.id, candidate.slot
        LIMIT p_limit;
    END;
    $function$;
  $create$, data_schema);

  -- Request controlled rotation before Modal's hard creation-time timeout.
  -- Existing passive viewer holders are evicted because they cannot mutate
  -- workspace state and may reconnect to the successor. Direct API operations
  -- can mutate files/git/terminal state, so they remain blockers until their
  -- normal release or the existing direct-holder TTL reaper proves them stale.
  -- Turn/process holders likewise remain until their explicit settlement path.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.request_due_sandbox_rotations(
      p_lead_ms bigint,
      p_limit integer
    )
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      requested integer;
      requested_ids uuid[];
    BEGIN
      IF p_lead_ms IS NULL OR p_lead_ms < 0 OR p_lead_ms > 86400000 THEN
        RAISE EXCEPTION 'sandbox rotation lead must be between 0 and 24h'
          USING ERRCODE = '22023';
      END IF;
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION 'sandbox rotation batch limit must be between 1 and 500'
          USING ERRCODE = '22023';
      END IF;

      PERFORM pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);

      WITH candidates AS MATERIALIZED (
        SELECT lease.id
        FROM %1$I.sandbox_leases lease
        WHERE lease.backend = 'modal'
          AND lease.liveness IN ('warming', 'warm')
          AND lease.provider_deadline_at IS NOT NULL
          AND lease.provider_deadline_at
            <= pg_catalog.now()
              + pg_catalog.make_interval(secs => p_lead_ms / 1000.0)
          AND lease.rotation_requested_at IS NULL
        ORDER BY lease.provider_deadline_at, lease.id
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
      ),
      due AS (
        UPDATE %1$I.sandbox_leases lease SET
          rotation_requested_at = pg_catalog.now(),
          rotation_reason = 'provider_deadline',
          updated_at = pg_catalog.now()
        FROM candidates
        WHERE lease.id = candidates.id
        RETURNING lease.id
      )
      SELECT
        coalesce(pg_catalog.array_agg(due.id), ARRAY[]::uuid[]),
        pg_catalog.count(*)::integer
      INTO requested_ids, requested
      FROM due;

      DELETE FROM %1$I.sandbox_lease_holders holder
      WHERE holder.lease_id = ANY(requested_ids)
        AND holder.kind = 'viewer';

      UPDATE %1$I.sandbox_leases lease SET
        refcount = counts.total,
        turn_holders = counts.turns,
        viewer_holders = counts.viewers,
        liveness = CASE
          WHEN lease.liveness = 'warm' AND counts.total = 0 THEN 'draining'
          ELSE lease.liveness
        END,
        expires_at = CASE
          WHEN lease.liveness = 'warm' AND counts.total = 0
          THEN pg_catalog.now() - interval '1 millisecond'
          ELSE lease.expires_at
        END,
        updated_at = pg_catalog.now()
      FROM (
        SELECT candidate.id,
          (SELECT pg_catalog.count(*) FROM %1$I.sandbox_lease_holders holder
            WHERE holder.lease_id = candidate.id)::int AS total,
          (SELECT pg_catalog.count(*) FROM %1$I.sandbox_lease_holders holder
            WHERE holder.lease_id = candidate.id AND holder.kind = 'turn')::int AS turns,
          (SELECT pg_catalog.count(*) FROM %1$I.sandbox_lease_holders holder
            WHERE holder.lease_id = candidate.id AND holder.kind = 'viewer')::int AS viewers
        FROM unnest(requested_ids) requested_id(id)
        JOIN %1$I.sandbox_leases candidate ON candidate.id = requested_id.id
      ) counts
      WHERE lease.id = counts.id;

      RETURN requested;
    END;
    $function$;
  $create$, data_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.sandbox_checkpoint_artifact_inventory()
    RETURNS TABLE (state text, count bigint)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
      SELECT artifact.state, pg_catalog.count(*)::bigint
      FROM %1$I.sandbox_checkpoint_artifacts artifact
      GROUP BY artifact.state
      ORDER BY artifact.state;
    $function$;
  $create$, data_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.sandbox_rotation_backlog()
    RETURNS TABLE (
      requested bigint,
      overdue bigint,
      turn_blocked bigint,
      direct_blocked bigint,
      process_blocked bigint
    )
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
      SELECT
        pg_catalog.count(*) FILTER (
          WHERE lease.rotation_requested_at IS NOT NULL
        )::bigint,
        pg_catalog.count(*) FILTER (
          WHERE lease.rotation_requested_at IS NOT NULL
            AND lease.provider_deadline_at <= pg_catalog.now()
        )::bigint,
        pg_catalog.count(*) FILTER (
          WHERE lease.rotation_requested_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM %1$I.sandbox_lease_holders holder
              WHERE holder.lease_id = lease.id AND holder.kind = 'turn'
            )
        )::bigint,
        pg_catalog.count(*) FILTER (
          WHERE lease.rotation_requested_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM %1$I.sandbox_lease_holders holder
              WHERE holder.lease_id = lease.id AND holder.kind = 'direct'
            )
        )::bigint,
        pg_catalog.count(*) FILTER (
          WHERE lease.rotation_requested_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM %1$I.sandbox_lease_holders holder
              WHERE holder.lease_id = lease.id AND holder.kind = 'process'
            )
        )::bigint
      FROM %1$I.sandbox_leases lease
      WHERE lease.backend = 'modal'
        AND lease.liveness IN ('warming', 'warm', 'draining');
    $function$;
  $create$, data_schema);
END
$checkpoint_legacy_and_rotation_functions$;

-- Existing live Modal leases predate durable provider creation clocks. Their
-- true remaining lifetime is unknowable, so fail safe: make them immediately
-- eligible for controlled rotation after the new worker starts.
UPDATE sandbox_leases
SET provider_created_at = now() - interval '1 millisecond',
    provider_deadline_at = now(),
    updated_at = now()
WHERE backend = 'modal'
  AND liveness IN ('warming', 'warm', 'draining')
  AND instance_id IS NOT NULL
  AND provider_deadline_at IS NULL;

-- PostgreSQL grants new functions to PUBLIC by default. Every function below
-- either bypasses workspace RLS or is an internal trigger implementation, so
-- leave execution to the migration owner and explicitly granted application
-- role only.
REVOKE ALL ON FUNCTION opengeni_private.validate_sandbox_checkpoint_refs()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.validate_sandbox_checkpoint_artifact_refs()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.enforce_sandbox_checkpoint_artifact_immutability()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.claim_sandbox_checkpoint_artifacts(uuid, integer, bigint)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.settle_sandbox_checkpoint_artifact(uuid, uuid, boolean, text, bigint)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.prune_deleted_sandbox_checkpoint_artifacts(bigint, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.list_legacy_modal_checkpoint_slots(integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.request_due_sandbox_rotations(bigint, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.sandbox_checkpoint_artifact_inventory()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.sandbox_rotation_backlog()
  FROM PUBLIC;

DO $grants$
DECLARE data_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.sandbox_checkpoint_artifacts TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT SELECT, UPDATE ON TABLE %I.sandbox_leases TO opengeni_app',
      data_schema
    );
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_sandbox_checkpoint_artifacts(uuid, integer, bigint)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.settle_sandbox_checkpoint_artifact(uuid, uuid, boolean, text, bigint)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.prune_deleted_sandbox_checkpoint_artifacts(bigint, integer)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.list_legacy_modal_checkpoint_slots(integer)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.request_due_sandbox_rotations(bigint, integer)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.sandbox_checkpoint_artifact_inventory()
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.sandbox_rotation_backlog()
      TO opengeni_app;
  END IF;
END
$grants$;
