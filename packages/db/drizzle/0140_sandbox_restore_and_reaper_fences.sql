-- deployment-mode: rolling
-- A legacy Modal checkpoint is immutable at the generation at which it was
-- adopted. Restoring it and then writing to the live workspace must advance
-- workspace_generation without invalidating that checkpoint. Migration 0138
-- accidentally required archive_generation = workspace_generation forever,
-- so the first post-restore mutation failed the deferred scope trigger.
--
-- The global lease reaper also used one statement snapshot to count holders
-- before waiting on a concurrently acquired lease row. PostgreSQL could then
-- apply that stale zero count after the acquire committed, changing a live
-- lease to draining underneath its new owner. The replacement reaper locks a
-- bounded, fair batch with SKIP LOCKED first and touches only that exact batch.

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
    DECLARE legacy_archive_rebound boolean := false;
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        legacy_archive_rebound :=
          OLD.current_checkpoint_artifact_id = NEW.current_checkpoint_artifact_id
          AND OLD.archive_generation IS DISTINCT FROM NEW.archive_generation;
      END IF;

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
            AND (
              NEW.archive_generation IS NULL
              OR legacy_archive_rebound
            )
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

DO $bounded_lock_first_reaper$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.reap_sandbox_leases(
      p_viewer_holder_ttl_ms bigint,
      p_turn_holder_ttl_ms bigint,
      p_idle_grace_ms bigint
    )
    RETURNS TABLE (
      workspace_id uuid,
      sandbox_group_id uuid,
      instance_id text,
      lease_epoch integer
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE locked_ids uuid[];
    BEGIN
      PERFORM pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);

      -- Every holder-creating runtime path locks its lease first. SKIP LOCKED
      -- therefore gives one coherent statement snapshot without ever waiting
      -- behind an acquire and later publishing pre-wait counts. Old/corrupt
      -- cold rows carrying holders are included for bounded repair. Updating
      -- selected rows' updated_at below rotates a backlog fairly.
      SELECT coalesce(
        pg_catalog.array_agg(candidate.id),
        ARRAY[]::uuid[]
      )
      INTO locked_ids
      FROM (
        SELECT lease.id
        FROM %1$I.sandbox_leases lease
        WHERE lease.liveness <> 'cold'
          OR EXISTS (
            SELECT 1
            FROM %1$I.sandbox_lease_holders holder
            WHERE holder.lease_id = lease.id
          )
        ORDER BY lease.updated_at, lease.id
        LIMIT 500
        FOR UPDATE OF lease SKIP LOCKED
      ) candidate;

      IF pg_catalog.cardinality(locked_ids) = 0 THEN
        RETURN;
      END IF;

      -- A legacy heartbeat/force-drain writer can still hold an individual
      -- holder row during a rolling rollout. Lock stale victims with SKIP
      -- LOCKED as well, avoiding a holder->lease / lease->holder deadlock.
      DELETE FROM %1$I.sandbox_lease_holders holder
      USING (
        SELECT stale.id
        FROM %1$I.sandbox_lease_holders stale
        WHERE stale.lease_id = ANY(locked_ids)
          AND stale.kind IN ('viewer', 'direct')
          AND stale.last_heartbeat_at
            < pg_catalog.now()
              - pg_catalog.make_interval(secs => p_viewer_holder_ttl_ms / 1000.0)
        FOR UPDATE OF stale SKIP LOCKED
      ) victim
      WHERE holder.id = victim.id;

      IF p_turn_holder_ttl_ms > 0 THEN
        DELETE FROM %1$I.sandbox_lease_holders holder
        USING (
          SELECT stale.id
          FROM %1$I.sandbox_lease_holders stale
          WHERE stale.lease_id = ANY(locked_ids)
            AND stale.kind = 'turn'
            AND stale.last_heartbeat_at
              < pg_catalog.now()
                - pg_catalog.make_interval(secs => p_turn_holder_ttl_ms / 1000.0)
          FOR UPDATE OF stale SKIP LOCKED
        ) victim
        WHERE holder.id = victim.id;
      END IF;

      UPDATE %1$I.sandbox_leases lease SET
        refcount = counts.total,
        turn_holders = counts.turns,
        viewer_holders = counts.viewers,
        liveness = CASE
          WHEN lease.liveness = 'warm' AND counts.total = 0 AND counts.turns = 0
          THEN 'draining' ELSE lease.liveness END,
        expires_at = CASE
          WHEN lease.liveness = 'warm' AND counts.total = 0 AND counts.turns = 0
          THEN CASE
            WHEN lease.rotation_requested_at IS NOT NULL
            THEN pg_catalog.now() - interval '1 millisecond'
            ELSE pg_catalog.now()
              + pg_catalog.make_interval(secs => p_idle_grace_ms / 1000.0)
          END
          ELSE lease.expires_at END,
        updated_at = pg_catalog.now()
      FROM (
        SELECT candidate.id,
          pg_catalog.count(holder.id)::int AS total,
          pg_catalog.count(holder.id)
            FILTER (WHERE holder.kind = 'turn')::int AS turns,
          pg_catalog.count(holder.id)
            FILTER (WHERE holder.kind = 'viewer')::int AS viewers
        FROM pg_catalog.unnest(locked_ids) candidate(id)
        LEFT JOIN %1$I.sandbox_lease_holders holder
          ON holder.lease_id = candidate.id
        GROUP BY candidate.id
      ) counts
      WHERE lease.id = counts.id;

      UPDATE %1$I.sandbox_leases lease SET
        liveness = 'cold',
        instance_id = null,
        lease_epoch = lease.lease_epoch + 1,
        resume_state = opengeni_private.warming_reset_resume_state_v2(
          lease.backend,
          lease.resume_backend_id,
          lease.resume_state,
          lease.workspace_generation,
          lease.archive_generation,
          pg_catalog.clock_timestamp()
        ),
        resume_backend_id = CASE
          WHEN coalesce(
            lease.resume_state #>> '{sessionState,workspaceArchive}', ''
          ) <> ''
            OR coalesce(
              lease.resume_state #>> '{sessionState,workspaceArchivePrev}', ''
            ) <> ''
          THEN coalesce(lease.resume_backend_id, lease.backend)
          ELSE null END,
        data_plane_url = null,
        terminal_data_plane_url = null,
        provider_created_at = null,
        provider_deadline_at = null,
        rotation_requested_at = null,
        rotation_reason = null,
        updated_at = pg_catalog.now()
      WHERE lease.id = ANY(locked_ids)
        AND lease.liveness = 'warming'
        AND lease.expires_at < pg_catalog.now()
        AND lease.instance_id IS NULL;

      UPDATE %1$I.sandbox_leases lease SET
        liveness = 'draining',
        refcount = 0,
        turn_holders = 0,
        viewer_holders = 0,
        data_plane_url = null,
        terminal_data_plane_url = null,
        lease_epoch = lease.lease_epoch + 1,
        expires_at = pg_catalog.now() - interval '1 millisecond',
        updated_at = pg_catalog.now()
      WHERE lease.id = ANY(locked_ids)
        AND lease.liveness = 'warming'
        AND lease.expires_at < pg_catalog.now()
        AND lease.instance_id IS NOT NULL;

      RETURN QUERY
        SELECT lease.workspace_id, lease.sandbox_group_id,
          lease.instance_id, lease.lease_epoch
        FROM %1$I.sandbox_leases lease
        WHERE lease.id = ANY(locked_ids)
          AND lease.liveness = 'draining'
          AND lease.expires_at < pg_catalog.now()
          AND lease.refcount = 0;
    END;
    $function$;
  $create$, data_schema);
END
$bounded_lock_first_reaper$;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.reap_sandbox_leases(bigint, bigint, bigint)
      TO opengeni_app;
  END IF;
END
$grants$;
