-- deployment-mode: rolling
-- Exact rig-version definitions remain immutable. This additive operational
-- metadata records build-once provider image status and immutable identities.

ALTER TABLE rig_versions
  ADD COLUMN provider_images jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE rig_versions
  ADD CONSTRAINT rig_versions_provider_images_object_chk
  CHECK (jsonb_typeof(provider_images) = 'object');

-- Reuse the existing provider-artifact ledger and global GC. A rig-version
-- reference protects the exact image for that immutable version. A verified
-- change protects it only while its base remains active/promotable; rejected,
-- failed, abandoned-after-supersession, and deleted targets fall back to the
-- ordinary candidate/current collection path.
DO $rig_provider_image_checkpoint_gc$
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
               OR (
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
    $function$;
  $create$, data_schema);
END
$rig_provider_image_checkpoint_gc$;
