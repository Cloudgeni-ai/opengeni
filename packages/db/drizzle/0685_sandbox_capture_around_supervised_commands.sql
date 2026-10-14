-- deployment-mode: rolling
-- A warm box running a supervised background command was never checkpointed:
-- the 0496 lease guard refused every capture claim and archive publication
-- while one was active, so the box's only save was the mandatory pre-deadline
-- save and an unplanned provider loss lost every write since the last turn.
-- That guard exists so legacy containment (enroll, capture, publish, then
-- terminate) can never kill a supervised process tree without its terminal
-- receipt. A warm point-in-time capture that runs around the command does
-- not terminate anything: the claim is marked concurrent
-- (archive_capture_concurrent_capture_id, migration 0659), only the warm fold
-- may publish it, one generation behind the workspace, and the box and
-- command keep running. The receipt lives in the supervisor's memory behind
-- its control socket, never in the snapshot, and typed provider loss still
-- settles the command lost with no proof.
-- The guard now admits exactly those two transitions while a supervised
-- process is active: a warm concurrent claim on the box the supervised
-- commands run on, and the warm fold of such a claim. Drain enrollment, drain
-- claims, published-at stamps and every other archive change still raise.
-- The trigger keeps its name: supervisedCommandProtocolReady checks it before
-- new supervised launches. Previous-release workers never request a
-- supervised warm claim (their own gate refuses it first), so narrowing is
-- rolling-safe. The idle checkpoint inventory (migration 0680) stops
-- skipping such boxes; the exact claim re-checks every fact under the lock.
-- Until the rollout finishes, a previous-release reaper may list such a box
-- and be refused by its own claim gate; the attempt stamp throttles that to
-- once per snapshot interval per box.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE OR REPLACE FUNCTION opengeni_private.supervised_command_capture_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $capture$
DECLARE
  archive_keys_unchanged boolean;
BEGIN
  IF NOT (
    NEW.unobservable_command_drain_ids IS NOT NULL AND
      NEW.unobservable_command_drain_ids IS DISTINCT FROM OLD.unobservable_command_drain_ids
    OR NEW.archive_capture_id IS NOT NULL AND NEW.archive_capture_id IS DISTINCT FROM OLD.archive_capture_id
    OR NEW.archive_capture_published_at IS NOT NULL AND
      NEW.archive_capture_published_at IS DISTINCT FROM OLD.archive_capture_published_at
    OR NEW.archive_generation IS NOT NULL AND NEW.archive_generation IS DISTINCT FROM OLD.archive_generation
    OR (NEW.resume_state #> '{sessionState,workspaceArchive}') IS DISTINCT FROM
       (OLD.resume_state #> '{sessionState,workspaceArchive}')
    OR (NEW.resume_state #> '{sessionState,workspaceArchiveMeta}') IS DISTINCT FROM
       (OLD.resume_state #> '{sessionState,workspaceArchiveMeta}')
    OR (NEW.resume_state #> '{sessionState,workspaceArchiveRef}') IS DISTINCT FROM
       (OLD.resume_state #> '{sessionState,workspaceArchiveRef}')
  ) OR NOT EXISTS (
    SELECT 1 FROM sandbox_retained_processes
    WHERE lease_id = NEW.id AND state = 'active' AND provider_command ? 'supervision'
  ) THEN
    RETURN NEW;
  END IF;
  archive_keys_unchanged :=
    (NEW.resume_state #> '{sessionState,workspaceArchive}') IS NOT DISTINCT FROM
      (OLD.resume_state #> '{sessionState,workspaceArchive}')
    AND (NEW.resume_state #> '{sessionState,workspaceArchiveMeta}') IS NOT DISTINCT FROM
      (OLD.resume_state #> '{sessionState,workspaceArchiveMeta}')
    AND (NEW.resume_state #> '{sessionState,workspaceArchiveRef}') IS NOT DISTINCT FROM
      (OLD.resume_state #> '{sessionState,workspaceArchiveRef}');
  -- Both admitted transitions keep the box warm on the same epoch and
  -- instance with no drain enrolled and nothing marked published.
  IF OLD.liveness = 'warm' AND NEW.liveness = 'warm'
    AND NEW.lease_epoch = OLD.lease_epoch
    AND NEW.instance_id IS NOT NULL AND NEW.instance_id = OLD.instance_id
    AND OLD.unobservable_command_drain_ids IS NULL
    AND NEW.unobservable_command_drain_ids IS NULL
    AND NEW.archive_capture_published_at IS NULL
    -- Every active supervised command runs on this exact box.
    AND NOT EXISTS (
      SELECT 1 FROM sandbox_retained_processes
      WHERE lease_id = NEW.id AND state = 'active' AND provider_command ? 'supervision'
        AND (lease_epoch <> NEW.lease_epoch OR provider_instance_id IS DISTINCT FROM NEW.instance_id)
    )
    AND (
      -- A fresh warm claim recorded as running around commands.
      (OLD.archive_capture_id IS NULL AND NEW.archive_capture_id IS NOT NULL
        AND NEW.archive_capture_concurrent_capture_id = NEW.archive_capture_id
        AND NEW.archive_generation IS NOT DISTINCT FROM OLD.archive_generation
        AND archive_keys_unchanged)
      -- Its warm fold: published one generation behind the workspace.
      OR (OLD.archive_capture_id IS NOT NULL
        AND OLD.archive_capture_concurrent_capture_id = OLD.archive_capture_id
        AND NEW.archive_capture_id IS NULL
        AND OLD.archive_capture_generation IS NOT NULL
        AND NEW.archive_generation = OLD.archive_capture_generation
        AND NEW.workspace_generation = OLD.workspace_generation + 1
        -- Never complete while the command may still write.
        AND NEW.archive_generation < NEW.workspace_generation)
    )
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Supervised command blocks legacy containment and checkpoint publication' USING ERRCODE = '55000';
END
$capture$;
REVOKE ALL ON FUNCTION opengeni_private.supervised_command_capture_guard() FROM PUBLIC;

DO $install$
DECLARE target_schema text := current_schema(); role_name text;
BEGIN
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.list_idle_checkpoint_candidates(
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
        -- Every holder is one the capture may run around: a viewer, an
        -- interaction, or an active command (supervised or not) on this
        -- exact box.
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
                AND process.state = 'active'))
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
