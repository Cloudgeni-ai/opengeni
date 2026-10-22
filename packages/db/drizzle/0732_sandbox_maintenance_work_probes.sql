-- deployment-mode: rolling
-- Read-only "is there anything to do?" checks for the sandbox lifecycle
-- dispatchers: the lease reaper, the idle checkpoint sweep, the browser
-- checkpoint sweep and the reaper's maintenance pass. A control worker
-- evaluates them on every reaper tick and starts a dispatcher workflow only
-- when its check returns true, so a deployment with no warm sandboxes and no
-- pending reconciliation no longer creates workflow executions per tick.
--
-- Same contract as 0730: each check is a superset of the claim or inventory it
-- previews (it may say yes when that finds nothing, never no when it would find
-- something), takes no row locks, writes nothing, opens no tenancy inventory,
-- and runs with exactly the owner, grants and search path of what it previews.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $install$
DECLARE
  target_schema text := current_schema();
  probe record;
  role_name text;
  claim_owner text;
BEGIN
  -- reap_sandbox_leases locks exactly the leases that are not cold or still
  -- have a holder; rotation requests and command containment act on the same
  -- warm leases. Answered from the reaper's partial index.
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.sandbox_lease_reaper_due_v1()
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
      SELECT EXISTS (
        SELECT 1 FROM %1$I.sandbox_leases lease
        WHERE lease.liveness IN ('warming', 'warm', 'draining')
      ) OR EXISTS (SELECT 1 FROM %1$I.sandbox_lease_holders holder)
    $body$;
  $definition$, target_schema);

  -- The lease-level conditions of list_idle_checkpoint_candidates, without its
  -- holder, capture-claim and image checks (which only narrow it further).
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.sandbox_idle_checkpoint_due_v1(
      p_interval_ms bigint)
    RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
    DECLARE due_before timestamptz;
    BEGIN
      IF p_interval_ms IS NULL OR p_interval_ms < 1 THEN
        RAISE EXCEPTION 'invalid checkpoint interval' USING ERRCODE = '22023';
      END IF;
      due_before := now() - p_interval_ms * interval '1 millisecond';
      RETURN EXISTS (
        SELECT 1 FROM %1$I.sandbox_leases lease
        WHERE lease.liveness = 'warm' AND lease.backend = 'modal'
          AND lease.instance_id IS NOT NULL
          AND lease.turn_holders = 0 AND lease.refcount > 0
          AND lease.unobservable_command_drain_ids IS NULL
          AND lease.rotation_requested_at IS NULL
          AND (lease.reaper_hold_until IS NULL OR lease.reaper_hold_until <= now())
          AND (lease.archive_capture_last_attempt_at IS NULL
            OR lease.archive_capture_last_attempt_at <= due_before)
          AND (lease.idle_checkpoint_attempted_at IS NULL
            OR lease.idle_checkpoint_attempted_at <= due_before)
      );
    END $body$;
  $definition$, target_schema);

  -- Both lanes of list_browser_deadline_checkpoints: a checkpoint-capable
  -- browser held on a warm Modal box that is rotating for its provider deadline
  -- or is being suspended. The idle lane's exact operation match is omitted.
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.browser_deadline_checkpoint_due_v1()
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
      SELECT EXISTS (
        SELECT 1 FROM %1$I.sandbox_leases lease
        JOIN %1$I.browser_sessions browser
          ON browser.account_id = lease.account_id AND browser.workspace_id = lease.workspace_id
          AND browser.controller_host_sandbox_group_id = lease.sandbox_group_id
          AND browser.placement_instance_id = lease.instance_id
        WHERE lease.backend = 'modal' AND lease.liveness IN ('warming', 'warm')
          AND lease.instance_id IS NOT NULL
          AND browser.placement_kind = 'sandbox_group'
          AND browser.controller_generation IS NOT NULL AND browser.controller_id IS NOT NULL
          AND browser.capabilities->>'privateCheckpoint' = 'true'
          AND (
            browser.lifecycle IN ('suspending', 'suspended')
            OR (browser.lifecycle = 'active'
              AND lease.rotation_reason = 'provider_deadline'
              AND lease.rotation_requested_at IS NOT NULL
              AND lease.provider_deadline_at > now())
          )
          AND EXISTS (SELECT 1 FROM %1$I.sandbox_lease_holders holder
            WHERE holder.lease_id = lease.id AND holder.kind = 'interaction'
              AND holder.account_id = browser.account_id
              AND holder.workspace_id = browser.workspace_id
              AND holder.holder_id = 'browser-session:' || browser.id::text)
      )
    $body$;
  $definition$, target_schema);

  -- The maintenance pass's database work, one check per claim it runs. Warm
  -- metering, force drains, Modal create recovery and legacy checkpoint
  -- adoption all act on leases the reaper check above already covers.
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.session_system_update_outbox_due_v1()
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
      SELECT EXISTS (
        SELECT 1 FROM %1$I.session_system_update_outbox o WHERE o.status = 'pending'
      )
    $body$;
  $definition$, target_schema);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.session_list_snapshots_expired_v1()
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
      SELECT EXISTS (
        SELECT 1 FROM %1$I.session_list_snapshots s WHERE s.expires_at < now()
      )
    $body$;
  $definition$, target_schema);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.connected_command_reconciliation_due_v1()
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
      SELECT EXISTS (
        SELECT 1 FROM %1$I.session_background_commands command
        WHERE command.state IN ('running', 'stopping')
          AND command.reconcile_after <= now()
          AND command.provider = 'connected_machine'
      )
    $body$;
  $definition$, target_schema);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.connected_command_output_release_due_v1()
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
      SELECT EXISTS (
        SELECT 1 FROM %1$I.session_background_commands command
        WHERE command.provider = 'connected_machine' AND command.state = 'exited'
          AND command.output_release_observed_at IS NULL
          AND command.output_unavailable_at IS NULL
          AND command.reconcile_after <= now()
      )
    $body$;
  $definition$, target_schema);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.terminal_retained_processes_due_v1()
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
      SELECT EXISTS (
        SELECT 1 FROM %1$I.sandbox_retained_processes process
        WHERE process.state = 'active' AND process.reconcile_after <= now()
      )
    $body$;
  $definition$, target_schema);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.sandbox_ended_epoch_blockers_due_v1()
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
      SELECT EXISTS (
        SELECT 1 FROM %1$I.sandbox_workspace_mutation_admissions admission
        WHERE admission.settled_at IS NULL AND admission.route_kind = 'home'
          AND admission.provider_backend = 'modal'
      )
    $body$;
  $definition$, target_schema);

  -- Both phases of claim_sandbox_checkpoint_artifacts: recovering a stale
  -- delete claim, and every candidate no lease or Rig image still references.
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.sandbox_checkpoint_artifact_gc_due_v1(
      p_claim_ttl_ms bigint)
    RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
    BEGIN
      IF p_claim_ttl_ms IS NULL OR p_claim_ttl_ms < 1000 OR p_claim_ttl_ms > 3600000 THEN
        RAISE EXCEPTION 'invalid checkpoint artifact claim TTL' USING ERRCODE = '22023';
      END IF;
      RETURN EXISTS (
        SELECT 1 FROM %1$I.sandbox_checkpoint_artifacts artifact
        WHERE artifact.state = 'deleting'
          AND artifact.delete_claimed_at
            < now() - make_interval(secs => p_claim_ttl_ms / 1000.0)
      ) OR EXISTS (
        SELECT 1 FROM %1$I.sandbox_checkpoint_artifacts artifact
        WHERE (
            (artifact.state IN ('candidate', 'current', 'previous')
              AND artifact.created_at < now() - interval '15 minutes')
            OR (artifact.state IN ('delete_pending', 'delete_failed')
              AND coalesce(artifact.delete_after, artifact.created_at) <= now())
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
                 AND lease.archive_capture_generation = artifact.source_workspace_generation
               )
          )
          AND NOT EXISTS (
            SELECT 1 FROM %1$I.rig_versions version
            CROSS JOIN LATERAL jsonb_each(version.provider_images) provider_image
            WHERE provider_image.value ->> 'artifactId' = artifact.id::text
              AND provider_image.value ->> 'status' = 'ready'
          )
          AND NOT EXISTS (
            SELECT 1 FROM %1$I.rig_changes change
            JOIN %1$I.rig_versions base
              ON base.id = change.base_version_id
             AND base.workspace_id = change.workspace_id
             AND base.active = true
            WHERE change.status IN ('verifying', 'proposed')
              AND change.verification #>> '{providerImage,artifactId}' = artifact.id::text
              AND change.verification #>> '{providerImage,status}' = 'ready'
          )
      );
    END $body$;
  $definition$, target_schema);

  FOR probe IN
    SELECT * FROM (VALUES
      ('opengeni_private.sandbox_lease_reaper_due_v1()',
        'opengeni_private.reap_sandbox_leases(bigint,bigint,bigint,bigint)'),
      ('opengeni_private.sandbox_idle_checkpoint_due_v1(bigint)',
        'opengeni_private.list_idle_checkpoint_candidates(integer,bigint)'),
      ('opengeni_private.browser_deadline_checkpoint_due_v1()',
        'opengeni_private.list_browser_deadline_checkpoints(integer)'),
      ('opengeni_private.session_system_update_outbox_due_v1()',
        'opengeni_private.claim_session_system_update_outbox_v2(integer)'),
      ('opengeni_private.session_list_snapshots_expired_v1()',
        'opengeni_private.reap_expired_session_list_snapshots(integer)'),
      ('opengeni_private.connected_command_reconciliation_due_v1()',
        'opengeni_private.claim_connected_machine_background_commands(uuid,integer,bigint,timestamp with time zone)'),
      ('opengeni_private.connected_command_output_release_due_v1()',
        'opengeni_private.claim_connected_command_output_releases(uuid,integer,bigint,timestamp with time zone)'),
      ('opengeni_private.terminal_retained_processes_due_v1()',
        'opengeni_private.claim_terminal_retained_processes(uuid,integer,bigint)'),
      ('opengeni_private.sandbox_ended_epoch_blockers_due_v1()',
        'opengeni_private.list_sandbox_ended_epoch_blockers(integer)'),
      ('opengeni_private.sandbox_checkpoint_artifact_gc_due_v1(bigint)',
        'opengeni_private.claim_sandbox_checkpoint_artifacts(uuid,integer,bigint)')
    ) AS probes(signature, claim)
  LOOP
    -- Same owner as what it previews: the same visibility and no new
    -- data-owner capability.
    SELECT pg_get_userbyid(proowner) INTO STRICT claim_owner FROM pg_proc
      WHERE oid = probe.claim::regprocedure;
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I', probe.signature, claim_owner);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', probe.signature);
    -- Preserve each claim's runtime grant set, including custom role names.
    FOR role_name IN SELECT rolname FROM pg_roles
      WHERE rolname <> current_user AND has_function_privilege(oid, probe.claim, 'EXECUTE')
    LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', probe.signature, role_name);
    END LOOP;
  END LOOP;
END $install$;
