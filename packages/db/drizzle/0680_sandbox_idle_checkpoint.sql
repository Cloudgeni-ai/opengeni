-- deployment-mode: rolling
-- Inventory of warm Modal boxes that need a checkpoint while no turn holds
-- them. A box stays warm between turns for as long as something else holds it:
-- an open desktop or terminal viewer, a browser/computer controller, or a
-- running background command (the session waits for it, waits for input, or
-- awaits approval). Turn heartbeats stop with the turn, and the zero-holder
-- drain and idle containment leave a held box alone, so before this its only
-- save was the mandatory pre-deadline save, up to a day later.
-- Dirty means a write the newest archive may not cover: a generation it does
-- not include, or a viewer/interaction attached now or since the last capture
-- claimed with none attached (those can write without a generation
-- admission). Inventory only: the exact warm capture claim re-checks
-- every holder, open request, cleanliness and throttle fact under the lease
-- lock before any provider capture. Additive: older workers never call it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- Idle sweep cadence per box, stamped before each attempt whatever its
-- outcome, so a refused or failing box cannot hold a batch slot every sweep.
ALTER TABLE sandbox_leases ADD COLUMN IF NOT EXISTS idle_checkpoint_attempted_at timestamptz;
-- A viewer or interaction can write /workspace without a generation
-- admission. The earliest such attach not yet covered by a capture claimed
-- with none attached, so a writer that detached before the next capture still
-- leaves the box dirty. Nullable expansion; older writers leave it null and
-- keep the presence-only behavior until they are replaced.
ALTER TABLE sandbox_leases ADD COLUMN IF NOT EXISTS untracked_writer_since timestamptz;

-- A new lease epoch is a new box restored from the archive: nothing it holds
-- is uncaptured yet.
CREATE OR REPLACE FUNCTION opengeni_private.clear_untracked_writer_since()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.untracked_writer_since := NULL;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.clear_untracked_writer_since() FROM PUBLIC;
DROP TRIGGER IF EXISTS sandbox_untracked_writer_epoch_clear ON sandbox_leases;
CREATE TRIGGER sandbox_untracked_writer_epoch_clear
  BEFORE UPDATE OF lease_epoch ON sandbox_leases FOR EACH ROW
  WHEN (NEW.lease_epoch IS DISTINCT FROM OLD.lease_epoch
    AND NEW.untracked_writer_since IS NOT NULL)
  EXECUTE FUNCTION opengeni_private.clear_untracked_writer_since();

DO $install$
DECLARE target_schema text := current_schema(); role_name text;
BEGIN
  EXECUTE format($definition$
    CREATE FUNCTION opengeni_private.list_idle_checkpoint_candidates(
      p_limit integer, p_interval_ms bigint)
    RETURNS TABLE(account_id uuid, workspace_id uuid, sandbox_group_id uuid,
      lease_epoch integer, instance_id text)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
    DECLARE inventory_id uuid; due_before timestamptz;
    BEGIN
      IF p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'invalid checkpoint batch'; END IF;
      IF p_interval_ms IS NULL OR p_interval_ms < 1 THEN
        RAISE EXCEPTION 'invalid checkpoint interval';
      END IF;
      due_before := now() - p_interval_ms * interval '1 millisecond';
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      RETURN QUERY SELECT lease.account_id, lease.workspace_id, lease.sandbox_group_id,
        lease.lease_epoch, lease.instance_id
      FROM %1$I.sandbox_leases lease
      WHERE lease.backend = 'modal' AND lease.liveness = 'warm'
        AND lease.instance_id IS NOT NULL
        AND lease.turn_holders = 0
        -- Something other than a turn keeps it warm; a box no holder keeps
        -- warm belongs to the idle drain, which captures before teardown.
        AND lease.refcount > 0
        AND lease.unobservable_command_drain_ids IS NULL
        AND lease.rotation_requested_at IS NULL
        AND (lease.reaper_hold_until IS NULL OR lease.reaper_hold_until <= now())
        AND (lease.archive_generation IS NULL
          OR lease.archive_generation < lease.workspace_generation
          OR lease.untracked_writer_since IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM %1$I.sandbox_lease_holders writer
            WHERE writer.lease_id = lease.id AND writer.kind IN ('viewer', 'interaction')))
        -- Coalesced with every other warm capture of the box on one clock.
        AND (lease.archive_capture_last_attempt_at IS NULL
          OR lease.archive_capture_last_attempt_at <= due_before)
        -- And never more than once per interval from this sweep, whatever the
        -- previous attempt's outcome.
        AND (lease.idle_checkpoint_attempted_at IS NULL
          OR lease.idle_checkpoint_attempted_at <= due_before)
        -- No capture in progress, or one whose owner died: past its deadline,
        -- takeover-safe and never published.
        AND (lease.archive_capture_id IS NULL OR (
          lease.archive_capture_published_at IS NULL
          AND lease.archive_capture_deadline_at <= now()
          AND lease.archive_capture_takeover_safe))
        -- Only a paused-box (native Modal) image may run around commands.
        -- Same resolution as the claim path's leaseCaptureIsPointInTime.
        AND (CASE
          WHEN jsonb_typeof(lease.resume_state -> 'sessionState') = 'object' THEN coalesce(
            CASE WHEN jsonb_typeof(lease.resume_state #> '{sessionState,providerState}') = 'object'
              THEN lease.resume_state #>> '{sessionState,providerState,workspacePersistence}' END,
            lease.resume_state #>> '{sessionState,workspacePersistence}')
          ELSE coalesce(
            CASE WHEN jsonb_typeof(lease.resume_state -> 'providerState') = 'object'
              THEN lease.resume_state #>> '{providerState,workspacePersistence}' END,
            lease.resume_state ->> 'workspacePersistence')
        END) IN ('snapshot_filesystem', 'snapshot_directory')
        AND NOT EXISTS (
          SELECT 1 FROM %1$I.sandbox_retained_processes process
          WHERE process.lease_id = lease.id AND process.state = 'active'
            AND coalesce(process.provider_command, '{}'::jsonb) ? 'supervision'
        )
        -- Every holder is one the capture may run around: a viewer, an
        -- interaction, or an active unsupervised command on this exact box.
        -- A direct request or any other process holder blocks the claim.
        AND NOT EXISTS (
          SELECT 1 FROM %1$I.sandbox_lease_holders holder
          WHERE holder.lease_id = lease.id
            AND holder.kind NOT IN ('viewer', 'interaction')
            AND NOT (holder.kind = 'process' AND EXISTS (
              SELECT 1 FROM %1$I.sandbox_retained_processes process
              WHERE process.holder_id = holder.holder_id
                AND process.lease_id = lease.id AND process.lease_epoch = lease.lease_epoch
                AND process.provider_instance_id = lease.instance_id
                AND process.state = 'active'
                AND NOT (coalesce(process.provider_command, '{}'::jsonb) ? 'supervision')))
        )
      -- Least recently tried first; greatest() ignores a null clock.
      ORDER BY greatest(lease.archive_capture_last_attempt_at,
        lease.idle_checkpoint_attempted_at) NULLS FIRST, lease.id
      LIMIT p_limit;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END $body$;
  $definition$, target_schema);
  REVOKE ALL ON FUNCTION opengeni_private.list_idle_checkpoint_candidates(integer, bigint) FROM PUBLIC;
  FOR role_name IN SELECT rolname FROM pg_roles
    WHERE rolname <> current_user AND has_function_privilege(oid,
      'opengeni_private.reap_sandbox_leases(bigint,bigint,bigint,bigint)', 'EXECUTE')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.list_idle_checkpoint_candidates(integer, bigint) TO %I', role_name);
  END LOOP;
END $install$;

RESET statement_timeout;
RESET lock_timeout;
