-- deployment-mode: maintenance
-- maintenance-justification: new owner-only helpers change runtime posture;
--   older binaries require EXECUTE on unknown private routines and reject it.
-- Boolean maintenance probes must work when their owner cannot bypass FORCE
-- RLS. Keep source policies unchanged and idle probes read-only: transactionally
-- project only their predicate columns into private, owner-only scheduling indexes.
-- Claims still acquire their ordinary capabilities and fences against source rows.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $install$
DECLARE
  data_schema text := current_schema();
  source record;
  probe record;
  columns_sql text;
  new_columns text;
  old_columns text;
  excluded_columns text;
  select_columns text;
  projection text;
  definition text;
  original_definition text;
BEGIN
  -- Lock the whole source set in a deterministic order before opening any
  -- owner backfill window. Writers cannot slip between backfill and triggers.
  FOR source IN SELECT name FROM (VALUES
    ('browser_sessions'), ('enrollments'), ('rig_changes'), ('rig_versions'),
    ('sandbox_checkpoint_artifacts'), ('sandbox_lease_holders'), ('sandbox_leases'),
    ('sandbox_retained_processes'), ('sandbox_workspace_mutation_admissions'),
    ('session_background_commands'), ('session_list_snapshots'), ('sessions'), ('session_turns'),
    ('session_system_update_outbox'), ('session_workflow_wake_outbox'),
    ('site_auth_connections')
  ) sources(name) ORDER BY name LOOP
    EXECUTE format('LOCK TABLE %I.%I IN SHARE ROW EXCLUSIVE MODE', data_schema, source.name);
  END LOOP;

  FOR source IN SELECT * FROM (VALUES
    ('session_workflow_wake_outbox', 'session_id',
      'session_id,workspace_id,wake_revision,delivered_revision,next_attempt_at'),
    ('site_auth_connections', 'id',
      'id,workspace_id,status,health_policy,next_check_at,maintenance_operation_id,maintenance_claimed_at'),
    ('sandbox_leases', 'id',
      'id,account_id,workspace_id,sandbox_group_id,liveness,backend,instance_id,turn_holders,refcount,unobservable_command_drain_ids,rotation_requested_at,reaper_hold_until,archive_capture_last_attempt_at,idle_checkpoint_attempted_at,rotation_reason,provider_deadline_at,current_checkpoint_artifact_id,previous_checkpoint_artifact_id,lease_epoch,archive_capture_id,archive_capture_generation'),
    ('sandbox_lease_holders', 'id',
      'id,lease_id,kind,account_id,workspace_id,holder_id'),
    ('browser_sessions', 'id',
      'id,account_id,workspace_id,controller_host_sandbox_group_id,placement_instance_id,placement_kind,controller_generation,controller_id,capabilities,lifecycle'),
    ('session_system_update_outbox', 'id', 'id,status'),
    ('session_list_snapshots', 'id', 'id,workspace_id,expires_at'),
    ('sessions','id','id,workspace_id,active_turn_id,direct_control_state'),
    ('session_turns','id','id,workspace_id,session_id,status,metadata'),
    ('session_background_commands', 'id',
      'id,state,reconcile_after,provider,output_release_observed_at,output_unavailable_at,control_workspace_id,enrollment_id,connection_instance_id'),
    ('sandbox_retained_processes', 'id', 'id,state,reconcile_after'),
    ('sandbox_workspace_mutation_admissions', 'id',
      'id,settled_at,route_kind,provider_backend'),
    ('sandbox_checkpoint_artifacts', 'id',
      'id,state,delete_claimed_at,created_at,delete_after,provenance,source_lease_id,source_lease_epoch,source_instance_id,provider_backend,source_workspace_generation'),
    ('rig_versions', 'id', 'id,workspace_id,active,provider_images'),
    ('rig_changes', 'id', 'id,workspace_id,base_version_id,status,verification'),
    ('enrollments', 'id',
      'id,workspace_id,status,connection_instance_id,went_offline_reason,connection_lease_expires_at,went_offline_at')
  ) sources(name, key, columns) LOOP
    projection := 'maintenance_probe_' || source.name;
    SELECT string_agg(format('%I', c), ', '),
      string_agg(replace(expression, '__row__.', 'NEW.'), ', '),
      string_agg(replace(expression, '__row__.', 'OLD.'), ', '),
      string_agg(format('EXCLUDED.%I', c), ', '),
      string_agg(replace(expression, '__row__.', '') || format(' AS %I', c), ', ')
      INTO columns_sql, new_columns, old_columns, excluded_columns, select_columns
      FROM unnest(string_to_array(source.columns, ',')) c
      CROSS JOIN LATERAL (SELECT CASE c
        WHEN 'health_policy' THEN 'jsonb_build_object(''mode'', __row__.health_policy->''mode'')'
        WHEN 'capabilities' THEN 'jsonb_build_object(''privateCheckpoint'', __row__.capabilities->''privateCheckpoint'')'
        WHEN 'verification' THEN 'jsonb_build_object(''providerImage'', jsonb_build_object(''artifactId'', __row__.verification#>''{providerImage,artifactId}'', ''status'', __row__.verification#>''{providerImage,status}''))'
        WHEN 'provider_images' THEN '(SELECT coalesce(jsonb_object_agg(key, jsonb_build_object(''artifactId'', value->''artifactId'', ''status'', value->''status'')), ''{}''::jsonb) FROM jsonb_each(__row__.provider_images))'
        WHEN 'metadata' THEN 'CASE WHEN __row__.metadata ? ''sandboxSetupOutcomeUnknown'' THEN ''{"sandboxSetupOutcomeUnknown":true}''::jsonb ELSE ''{}''::jsonb END'
        ELSE format('__row__.%I', c) END AS expression) expressions;
    EXECUTE format('CREATE TABLE opengeni_private.%I AS SELECT %s FROM %I.%I WITH NO DATA',
      projection, select_columns, data_schema, source.name);
    EXECUTE format('ALTER TABLE opengeni_private.%I ADD PRIMARY KEY (%I)', projection, source.key);
    EXECUTE format('REVOKE ALL ON TABLE opengeni_private.%I FROM PUBLIC', projection);

    EXECUTE format($function$
      CREATE FUNCTION opengeni_private.%1$I() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
      AS $body$
      BEGIN
        IF TG_OP = 'TRUNCATE' THEN
          TRUNCATE opengeni_private.%5$I;
          RETURN NULL;
        END IF;
        IF TG_OP = 'UPDATE' AND ROW(%2$s) IS NOT DISTINCT FROM ROW(%3$s) THEN
          RETURN NULL;
        END IF;
        IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.%4$I IS DISTINCT FROM NEW.%4$I) THEN
          DELETE FROM opengeni_private.%5$I WHERE %4$I = OLD.%4$I;
        END IF;
        IF TG_OP <> 'DELETE' THEN
          INSERT INTO opengeni_private.%5$I (%6$s) VALUES (%2$s)
          ON CONFLICT (%4$I) DO UPDATE SET (%6$s) = (%7$s);
        END IF;
        RETURN NULL;
      END $body$;
    $function$, projection || '_sync', new_columns, old_columns, source.key,
      projection, columns_sql, excluded_columns);
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.%I() FROM PUBLIC', projection || '_sync');
    EXECUTE format('CREATE TRIGGER maintenance_probe_sync AFTER INSERT OR UPDATE OR DELETE ON %I.%I
      FOR EACH ROW EXECUTE FUNCTION opengeni_private.%I()', data_schema, source.name, projection || '_sync');
    EXECUTE format('CREATE TRIGGER maintenance_probe_truncate AFTER TRUNCATE ON %I.%I
      FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.%I()', data_schema, source.name, projection || '_sync');

    -- FORCE RLS remains enabled for runtime. The owner-only migration window
    -- is necessary even for backfill: a plain SELECT silently returns no rows.
    EXECUTE format('ALTER TABLE %I.%I NO FORCE ROW LEVEL SECURITY', data_schema, source.name);
    EXECUTE format('INSERT INTO opengeni_private.%I SELECT %s FROM %I.%I',
      projection, select_columns, data_schema, source.name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', data_schema, source.name);
  END LOOP;

  -- Clone only the nested enrollment predicate used by the read-only probe.
  -- Claims continue to use the original helper over the fenced source table.
  definition := pg_get_functiondef('opengeni_private.connected_output_runner_eligible_v1(uuid,uuid,text)'::regprocedure);
  IF position(format('%I.enrollments',data_schema) in definition)=0 THEN
    RAISE EXCEPTION 'connected output eligibility source drift';
  END IF;
  definition := replace(definition, 'connected_output_runner_eligible_v1', 'maintenance_probe_output_runner_eligible_v1');
  definition := replace(definition, format('%I.enrollments', data_schema),
    'opengeni_private.maintenance_probe_enrollments');
  EXECUTE definition;
  REVOKE ALL ON FUNCTION opengeni_private.maintenance_probe_output_runner_eligible_v1(uuid,uuid,text) FROM PUBLIC;

  FOR probe IN SELECT signature FROM (VALUES
    ('session_workflow_wakes_due_v1()'), ('site_auth_maintenance_due_v1(bigint)'),
    ('sandbox_lease_reaper_due_v1()'), ('sandbox_idle_checkpoint_due_v1(bigint)'),
    ('browser_deadline_checkpoint_due_v1()'), ('session_system_update_outbox_due_v1()'),
    ('session_list_snapshots_expired_v1()'), ('connected_command_reconciliation_due_v1()'),
    ('connected_command_output_release_due_v1()'), ('terminal_retained_processes_due_v1()'),
    ('sandbox_ended_epoch_blockers_due_v1()'), ('sandbox_checkpoint_artifact_gc_due_v1(bigint)')
  ) probes(signature) LOOP
    definition := pg_get_functiondef(('opengeni_private.' || probe.signature)::regprocedure);
    original_definition := definition;
    FOR source IN SELECT name FROM (VALUES
      ('session_workflow_wake_outbox'), ('site_auth_connections'), ('sandbox_leases'),
      ('sandbox_lease_holders'), ('browser_sessions'), ('session_system_update_outbox'),
      ('session_list_snapshots'), ('session_background_commands'), ('sandbox_retained_processes'),
      ('sandbox_workspace_mutation_admissions'), ('sandbox_checkpoint_artifacts'),
      ('rig_versions'), ('rig_changes'), ('sessions'), ('session_turns')
    ) sources(name) LOOP
      definition := replace(definition, format('%I.%I', data_schema, source.name),
        format('opengeni_private.%I', 'maintenance_probe_' || source.name));
    END LOOP;
    definition := replace(definition, 'opengeni_private.connected_output_runner_eligible_v1(',
      'opengeni_private.maintenance_probe_output_runner_eligible_v1(');
    IF position(format('%I.',data_schema) in definition)>0 OR
      (definition=original_definition AND position('opengeni_private.maintenance_probe_' in definition)=0) THEN
      RAISE EXCEPTION 'maintenance probe source drift: %',probe.signature;
    END IF;
    EXECUTE definition;
  END LOOP;
END $install$;

-- The same leading predicates as the original claim inventories. Cross-table
-- references have their own indexes; no per-tick capability or index writes.
CREATE INDEX ON opengeni_private.maintenance_probe_session_workflow_wake_outbox(next_attempt_at)
  WHERE wake_revision > delivered_revision;
CREATE INDEX ON opengeni_private.maintenance_probe_site_auth_connections(next_check_at)
  WHERE status = 'active' AND health_policy->>'mode' = 'maintained';
CREATE INDEX ON opengeni_private.maintenance_probe_sandbox_leases(liveness);
CREATE INDEX ON opengeni_private.maintenance_probe_sandbox_leases(current_checkpoint_artifact_id);
CREATE INDEX ON opengeni_private.maintenance_probe_sandbox_leases(previous_checkpoint_artifact_id);
CREATE INDEX ON opengeni_private.maintenance_probe_sandbox_lease_holders(lease_id,kind,holder_id);
CREATE INDEX ON opengeni_private.maintenance_probe_browser_sessions(controller_host_sandbox_group_id,placement_instance_id);
CREATE INDEX ON opengeni_private.maintenance_probe_session_system_update_outbox(status);
CREATE INDEX ON opengeni_private.maintenance_probe_session_list_snapshots(expires_at);
CREATE INDEX ON opengeni_private.maintenance_probe_session_turns(workspace_id,session_id)
  WHERE status='recovering' AND metadata ? 'sandboxSetupOutcomeUnknown';
CREATE INDEX ON opengeni_private.maintenance_probe_session_background_commands(reconcile_after)
  WHERE provider = 'connected_machine' AND state IN ('running','stopping','exited');
CREATE INDEX ON opengeni_private.maintenance_probe_sandbox_retained_processes(reconcile_after) WHERE state = 'active';
CREATE INDEX ON opengeni_private.maintenance_probe_sandbox_workspace_mutation_admissions(settled_at)
  WHERE settled_at IS NULL AND route_kind = 'home' AND provider_backend = 'modal';
CREATE INDEX ON opengeni_private.maintenance_probe_sandbox_checkpoint_artifacts(state,created_at);
CREATE INDEX ON opengeni_private.maintenance_probe_rig_changes(base_version_id)
  WHERE status IN ('verifying','proposed');
