-- deployment-mode: rolling
-- Checkpoint GC asks about each artifact's lease references with index probes
-- on the private lease projection instead of reading every lease row.
--
-- The claim tested "still referenced" against the UNION of every lease's
-- current and previous checkpoint ids, and the tombstone prune tested
-- "current = id OR previous = id", both on public.sandbox_leases. Neither
-- shape can probe an index, so every GC tick read the whole lease table, and
-- each lease row paid its row-security policies (FORCE RLS binds the owner),
-- which is most of the claim's time. The lease projection
-- (opengeni_private.maintenance_probe_sandbox_leases, 0848) carries the same
-- reference, capture and epoch columns, is written by a row trigger in the
-- writing transaction, has no row security and indexes both references and
-- the id. The due probe already decides from it.
--
-- Each test is now one NOT EXISTS per reference (and the capture test by
-- lease id), so it is an index probe. An artifact is referenced exactly when
-- a probe finds a lease, as before (NULL references never matched), so the
-- claimed, pruned and due answers are unchanged. The real tables still guard
-- every write: the deferred artifact validator rejects a 'deleting' state for
-- an artifact a lease references, and the lease foreign keys reject deleting
-- one.
--
-- The lease liveness and artifact state inventories (worker gauges, polled
-- often) count the projections too. Counted through the row-secured tables
-- by their owner, which FORCE RLS binds, they paid the policies per row and
-- saw only the rows some policy admitted (none for an ordinary gauge read);
-- the projections hold every row, so the gauges report the real counts.
--
-- Rolling: the routines keep their signatures, owners, grants and locking;
-- the GC claim, prune and due answers are unchanged. The previous release
-- calls them unchanged.
SET LOCAL lock_timeout = '5s';

DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($create$
CREATE OR REPLACE FUNCTION opengeni_private.maintenance_claim_checkpoint_gc_inner(p_claim_id uuid, p_limit integer, p_claim_ttl_ms bigint) RETURNS TABLE(id uuid, provider_backend text, provider_binding_key text, provider_binding jsonb, object_kind text, object_id text, delete_attempts integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'pg_temp'
    AS $body$
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
            SELECT 1 FROM opengeni_private.maintenance_probe_sandbox_leases lease
            WHERE lease.current_checkpoint_artifact_id = artifact.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM opengeni_private.maintenance_probe_sandbox_leases lease
            WHERE lease.previous_checkpoint_artifact_id = artifact.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM opengeni_private.maintenance_probe_sandbox_leases lease
            WHERE (
                 artifact.provenance = 'native_capture'
                 AND lease.id = artifact.source_lease_id
                 AND lease.lease_epoch = artifact.source_lease_epoch
                 AND lease.instance_id = artifact.source_instance_id
                 AND lease.backend = artifact.provider_backend
                 AND lease.archive_capture_id IS NOT NULL
                 AND lease.archive_capture_generation
                   = artifact.source_workspace_generation
               )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM %1$I.rig_versions version
            CROSS JOIN LATERAL pg_catalog.jsonb_each(version.provider_images) provider_image
            WHERE provider_image.value ->> 'artifactId' = artifact.id::text
              AND provider_image.value ->> 'status' = 'ready'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM %1$I.rig_changes change
            JOIN %1$I.rig_versions base
              ON base.id = change.base_version_id
             AND base.workspace_id = change.workspace_id
             AND base.active = true
            WHERE change.status IN ('verifying', 'proposed')
              AND change.verification #>> '{providerImage,artifactId}' = artifact.id::text
              AND change.verification #>> '{providerImage,status}' = 'ready'
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
    $body$;
  $create$, data_schema);

  EXECUTE pg_catalog.format($create$
CREATE OR REPLACE FUNCTION opengeni_private.maintenance_claim_checkpoint_prune_inner(p_retention_ms bigint, p_limit integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'pg_temp'
    AS $body$
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
            SELECT 1 FROM opengeni_private.maintenance_probe_sandbox_leases lease
            WHERE lease.current_checkpoint_artifact_id = artifact.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM opengeni_private.maintenance_probe_sandbox_leases lease
            WHERE lease.previous_checkpoint_artifact_id = artifact.id
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
    $body$;
  $create$, data_schema);

  CREATE OR REPLACE FUNCTION opengeni_private.sandbox_checkpoint_artifact_gc_due_v1(p_claim_ttl_ms bigint) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $body$
    BEGIN
      IF p_claim_ttl_ms IS NULL OR p_claim_ttl_ms < 1000 OR p_claim_ttl_ms > 3600000 THEN
        RAISE EXCEPTION 'invalid checkpoint artifact claim TTL' USING ERRCODE = '22023';
      END IF;
      RETURN EXISTS (
        SELECT 1 FROM opengeni_private.maintenance_probe_sandbox_checkpoint_artifacts artifact
        WHERE artifact.state = 'deleting'
          AND artifact.delete_claimed_at
            < now() - make_interval(secs => p_claim_ttl_ms / 1000.0)
      ) OR EXISTS (
        SELECT 1 FROM opengeni_private.maintenance_probe_sandbox_checkpoint_artifacts artifact
        WHERE (
            (artifact.state IN ('candidate', 'current', 'previous')
              AND artifact.created_at < now() - interval '15 minutes')
            OR (artifact.state IN ('delete_pending', 'delete_failed')
              AND coalesce(artifact.delete_after, artifact.created_at) <= now())
          )
          AND NOT EXISTS (
            SELECT 1 FROM opengeni_private.maintenance_probe_sandbox_leases lease
            WHERE lease.current_checkpoint_artifact_id = artifact.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM opengeni_private.maintenance_probe_sandbox_leases lease
            WHERE lease.previous_checkpoint_artifact_id = artifact.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM opengeni_private.maintenance_probe_sandbox_leases lease
            WHERE artifact.provenance = 'native_capture'
              AND lease.id = artifact.source_lease_id
              AND lease.lease_epoch = artifact.source_lease_epoch
              AND lease.instance_id = artifact.source_instance_id
              AND lease.backend = artifact.provider_backend
              AND lease.archive_capture_id IS NOT NULL
              AND lease.archive_capture_generation = artifact.source_workspace_generation
          )
          AND NOT EXISTS (
            SELECT 1 FROM opengeni_private.maintenance_probe_rig_versions version
            CROSS JOIN LATERAL jsonb_each(version.provider_images) provider_image
            WHERE provider_image.value ->> 'artifactId' = artifact.id::text
              AND provider_image.value ->> 'status' = 'ready'
          )
          AND NOT EXISTS (
            SELECT 1 FROM opengeni_private.maintenance_probe_rig_changes change
            JOIN opengeni_private.maintenance_probe_rig_versions base
              ON base.id = change.base_version_id
             AND base.workspace_id = change.workspace_id
             AND base.active = true
            WHERE change.status IN ('verifying', 'proposed')
              AND change.verification #>> '{providerImage,artifactId}' = artifact.id::text
              AND change.verification #>> '{providerImage,status}' = 'ready'
          )
      );
    END $body$;

  CREATE OR REPLACE FUNCTION opengeni_private.count_sandbox_leases_by_liveness() RETURNS TABLE(liveness text, count bigint)
    LANGUAGE sql SECURITY DEFINER
    AS $body$
  SELECT L.liveness, pg_catalog.count(*)::bigint
  FROM opengeni_private.maintenance_probe_sandbox_leases L
  GROUP BY L.liveness;
$body$;

  CREATE OR REPLACE FUNCTION opengeni_private.sandbox_checkpoint_artifact_inventory() RETURNS TABLE(state text, count bigint)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $body$
      SELECT artifact.state, pg_catalog.count(*)::bigint
      FROM opengeni_private.maintenance_probe_sandbox_checkpoint_artifacts artifact
      GROUP BY artifact.state
      ORDER BY artifact.state;
    $body$;
END $install$;
