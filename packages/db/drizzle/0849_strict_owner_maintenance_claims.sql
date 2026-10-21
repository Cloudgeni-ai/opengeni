-- deployment-mode: maintenance
-- maintenance-justification: owner-only claim helpers and validator privileges
--   change the runtime posture contract; old binaries cannot coexist.
-- Existing deployment-global maintenance entry points must see the same rows
-- on managed PostgreSQL as on superuser-owned installations. Authority is an
-- owner-only, operation-specific, backend/transaction-bound token, not a GUC.
-- Keep every claim predicate, lock order, lease identity and return shape.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE opengeni_private.maintenance_claim_capabilities (
  id uuid PRIMARY KEY,
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  operation text NOT NULL CHECK (operation IN ('wakes','snapshots','titles','site_auth','updates','checkpoint_gc','checkpoint_validate','output_release','ended_epoch','inventory','workspace_commands','schedule_cleanup'))
);
REVOKE ALL ON TABLE opengeni_private.maintenance_claim_capabilities FROM PUBLIC;

CREATE FUNCTION opengeni_private.maintenance_claim_active(p_actor text, p_operation text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT p_actor = current_user AND EXISTS (
    SELECT 1 FROM opengeni_private.maintenance_claim_capabilities c
    WHERE c.backend_pid = pg_backend_pid()
      AND c.transaction_id = pg_current_xact_id_if_assigned()
      AND c.operation = p_operation
  )
$$;
REVOKE ALL ON FUNCTION opengeni_private.maintenance_claim_active(text,text) FROM PUBLIC;
-- Policies need the predicate, but it can neither mint authority nor reveal data.
GRANT EXECUTE ON FUNCTION opengeni_private.maintenance_claim_active(text,text) TO PUBLIC;

CREATE FUNCTION opengeni_private.maintenance_title_event_visible(p_actor text,p_event_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT opengeni_private.maintenance_claim_active(p_actor,'titles') AND EXISTS (
    SELECT 1 FROM opengeni_private.automatic_session_title_fanout_outbox_v1 p
    WHERE p.event_id=p_event_id AND p.delivered_at IS NULL
  )
$$;
REVOKE ALL ON FUNCTION opengeni_private.maintenance_title_event_visible(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION opengeni_private.maintenance_title_event_visible(text,uuid) TO PUBLIC;

DO $policies$
DECLARE data_schema text := current_schema(); entry record; predicate text; existing record;
BEGIN
  FOR entry IN SELECT * FROM (VALUES
    ('session_workflow_wake_outbox','wakes','SELECT'), ('session_workflow_wake_outbox','wakes','UPDATE'),
    ('workspace_inference_controls','wakes','SELECT'),
    ('workspace_inference_controls','wakes','UPDATE'),
    ('workspaces','wakes','SELECT'), ('workspaces','wakes','UPDATE'),
    ('sessions','wakes','SELECT'), ('sessions','wakes','UPDATE'),
    ('session_attempt_interruptions','wakes','SELECT'), ('session_turn_attempts','wakes','SELECT'),
    ('session_list_snapshots','snapshots','SELECT'), ('session_list_snapshots','snapshots','UPDATE'), ('session_list_snapshots','snapshots','DELETE'),
    ('session_events','titles','SELECT'), ('sessions','titles','SELECT'),
    ('site_auth_connections','site_auth','SELECT'), ('site_auth_connections','site_auth','UPDATE'), ('sessions','site_auth','SELECT'),
    ('auth_runs','site_auth','SELECT'), ('workspace_interaction_revisions','site_auth','SELECT'),
    ('workspace_interaction_revisions','site_auth','INSERT'), ('workspace_interaction_revisions','site_auth','UPDATE'),
    ('session_system_update_outbox','updates','SELECT'), ('session_system_update_outbox','updates','UPDATE'), ('sessions','updates','SELECT'),
    ('sandbox_checkpoint_artifacts','checkpoint_gc','SELECT'), ('sandbox_checkpoint_artifacts','checkpoint_gc','UPDATE'),
    ('sandbox_checkpoint_artifacts','checkpoint_gc','DELETE'),
    ('sandbox_leases','checkpoint_gc','SELECT'), ('rig_versions','checkpoint_gc','SELECT'),
    ('rig_changes','checkpoint_gc','SELECT'),
    ('sandbox_checkpoint_artifacts','checkpoint_validate','SELECT'),
    ('sandbox_leases','checkpoint_validate','SELECT'),
    ('enrollments','output_release','SELECT'),
    ('sessions','ended_epoch','SELECT'), ('session_turns','ended_epoch','SELECT'),
    ('session_turn_attempts','ended_epoch','SELECT'),
    ('sandbox_workspace_mutation_admissions','ended_epoch','SELECT'),
    ('sandbox_leases','ended_epoch','SELECT'), ('sandbox_retained_processes','ended_epoch','SELECT'),
    ('sandbox_retained_processes','inventory','SELECT'), ('session_background_commands','inventory','SELECT'),
    ('session_turns','inventory','SELECT'), ('session_turn_attempts','inventory','SELECT'),
    ('sessions','inventory','SELECT'), ('sandbox_workspace_mutation_admissions','inventory','SELECT'),
    ('sandbox_lease_holders','inventory','SELECT'), ('sandbox_leases','inventory','SELECT'),
    ('session_background_commands','workspace_commands','SELECT'),
    ('session_background_commands','workspace_commands','UPDATE'),
    ('session_background_commands','workspace_commands','DELETE'),
    ('sessions','workspace_commands','SELECT'),
    ('temporal_schedule_cleanup_outbox','schedule_cleanup','SELECT'),
    ('temporal_schedule_cleanup_outbox','schedule_cleanup','UPDATE'),
    ('temporal_schedule_cleanup_outbox','schedule_cleanup','DELETE')
  ) policies(table_name,operation,command) LOOP
    predicate := format('(SELECT opengeni_private.maintenance_claim_active(current_user::text,%L))',entry.operation);
    -- Title delivery may read only the exact events represented by its outbox.
    IF entry.table_name = 'session_events' THEN
      predicate := 'CASE WHEN (SELECT opengeni_private.maintenance_claim_active(current_user::text,''titles'')) THEN opengeni_private.maintenance_title_event_visible(current_user::text,id) ELSE false END';
    END IF;
    EXECUTE format('CREATE POLICY %I ON %I.%I FOR %s %s (%s)',
      'maintenance_' || entry.operation || '_' || lower(entry.command),
      data_schema,entry.table_name,entry.command,CASE entry.command WHEN 'INSERT' THEN 'WITH CHECK' ELSE 'USING' END,predicate);
  END LOOP;
  -- Restrictive session reach still applies to ordinary callers. Only these
  -- fixed maintenance bodies may follow the sessions referenced by their work.
  predicate := '(SELECT opengeni_private.maintenance_claim_active(current_user::text,''wakes'')'
    || ' OR opengeni_private.maintenance_claim_active(current_user::text,''titles'')'
    || ' OR opengeni_private.maintenance_claim_active(current_user::text,''site_auth'')'
    || ' OR opengeni_private.maintenance_claim_active(current_user::text,''updates'')'
    || ' OR opengeni_private.maintenance_claim_active(current_user::text,''ended_epoch'')'
    || ' OR opengeni_private.maintenance_claim_active(current_user::text,''inventory'')'
    || ' OR opengeni_private.maintenance_claim_active(current_user::text,''workspace_commands''))';
  FOR existing IN SELECT polname, pg_get_expr(polqual,polrelid) AS using_expression,
    pg_get_expr(polwithcheck,polrelid) AS check_expression
    FROM pg_policy WHERE polrelid=format('%I.sessions',data_schema)::regclass
      AND polname IN ('session_visibility_isolation','site_viewer_isolation') LOOP
    EXECUTE format('ALTER POLICY %I ON %I.sessions USING ((%s) OR %s) WITH CHECK ((%s) OR %s)',
      existing.polname,data_schema,existing.using_expression,predicate,
      coalesce(existing.check_expression,existing.using_expression),predicate);
  END LOOP;
END $policies$;

DO $wrappers$
DECLARE
  data_schema text := current_schema(); entry record; routine record;
  definition text; header text; arguments text; invocation text; body text;
BEGIN
  FOR entry IN SELECT * FROM (VALUES
    ('claim_session_workflow_wakes(integer)','maintenance_claim_wakes_inner','wakes'),
    ('reap_expired_session_list_snapshots(integer)','maintenance_claim_snapshots_inner','snapshots'),
    ('claim_automatic_session_title_fanout_v1(integer)','maintenance_claim_titles_inner','titles'),
    ('claim_site_auth_maintenance(bigint,integer)','maintenance_claim_site_auth_inner','site_auth'),
    ('claim_session_system_update_outbox_v2(integer)','maintenance_claim_updates_inner','updates'),
    ('claim_sandbox_checkpoint_artifacts(uuid,integer,bigint)','maintenance_claim_checkpoint_gc_inner','checkpoint_gc'),
    ('settle_sandbox_checkpoint_artifact(uuid,uuid,boolean,text,bigint)','maintenance_claim_checkpoint_settle_inner','checkpoint_gc'),
    ('prune_deleted_sandbox_checkpoint_artifacts(bigint,integer)','maintenance_claim_checkpoint_prune_inner','checkpoint_gc'),
    ('claim_connected_command_output_releases(uuid,integer,bigint,timestamp with time zone)','maintenance_claim_output_release_inner','output_release'),
    ('list_sandbox_ended_epoch_blockers(integer)','maintenance_claim_ended_blockers_inner','ended_epoch'),
    ('list_sandbox_ended_epoch_setup_uncertainties(integer)','maintenance_claim_ended_setup_inner','ended_epoch'),
    ('count_active_retained_processes_by_owner_state()','maintenance_inventory_retained_inner','inventory'),
    ('count_expired_draining_sandbox_leases()','maintenance_inventory_draining_inner','inventory'),
    ('prepare_workspace_background_command_deletion(uuid,uuid)','maintenance_workspace_commands_prepare_inner','workspace_commands'),
    ('prune_settled_cross_workspace_background_commands(uuid,uuid)','maintenance_workspace_commands_prune_inner','workspace_commands'),
    ('claim_temporal_schedule_cleanups(uuid,integer,integer)','maintenance_schedule_cleanup_claim_inner','schedule_cleanup'),
    ('settle_temporal_schedule_cleanup(uuid,uuid,text)','maintenance_schedule_cleanup_settle_inner','schedule_cleanup'),
    ('complete_temporal_schedule_connector_cleanup(uuid,uuid)','maintenance_schedule_cleanup_connector_inner','schedule_cleanup')
  ) wrappers(signature,inner_name,operation) LOOP
    SELECT p.*, pg_get_function_identity_arguments(p.oid) AS identity_arguments,
      pg_get_functiondef(p.oid) AS definition INTO STRICT routine
      FROM pg_proc p WHERE p.oid=('opengeni_private.'||entry.signature)::regprocedure;
    definition := replace(routine.definition,
      'CREATE OR REPLACE FUNCTION opengeni_private.' || routine.proname || '(',
      'CREATE OR REPLACE FUNCTION opengeni_private.' || entry.inner_name || '(');
    IF definition = routine.definition THEN RAISE EXCEPTION 'maintenance claim definition drift: %',entry.signature; END IF;
    EXECUTE definition;
    EXECUTE format('ALTER FUNCTION opengeni_private.%I(%s) SET search_path = pg_catalog, %I, pg_temp',
      entry.inner_name,routine.identity_arguments,data_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.%I(%s) FROM PUBLIC', entry.inner_name,routine.identity_arguments);
    header := split_part(routine.definition,' LANGUAGE ',1);
    IF header = routine.definition THEN RAISE EXCEPTION 'maintenance claim header drift: %',entry.signature; END IF;
    SELECT coalesce(string_agg('$'||n::text,', '),'') INTO arguments FROM generate_series(1,routine.pronargs) n;
    invocation := format('opengeni_private.%I(%s)',entry.inner_name,arguments);
    body := format($body$
      DECLARE capability_id uuid := gen_random_uuid(); result_value %1$s;
      BEGIN
        %5$s
        INSERT INTO opengeni_private.maintenance_claim_capabilities VALUES
          (capability_id,pg_backend_pid(),pg_current_xact_id(),%2$L);
        %3$s;
        DELETE FROM opengeni_private.maintenance_claim_capabilities c WHERE c.id=capability_id;
        %4$s;
      EXCEPTION WHEN OTHERS THEN
        DELETE FROM opengeni_private.maintenance_claim_capabilities c WHERE c.id=capability_id;
        RAISE;
      END
    $body$,CASE WHEN routine.proretset THEN 'integer' ELSE format_type(routine.prorettype,NULL) END,
      entry.operation,
      CASE WHEN routine.proretset THEN 'RETURN QUERY SELECT * FROM '||invocation ELSE 'result_value := '||invocation END,
      CASE WHEN routine.proretset THEN 'RETURN' ELSE 'RETURN result_value' END,
      CASE routine.proname
        WHEN 'count_active_retained_processes_by_owner_state' THEN
          'IF NOT EXISTS (SELECT 1 FROM opengeni_private.maintenance_probe_sandbox_retained_processes WHERE state=''active'') THEN RETURN; END IF;'
        WHEN 'count_expired_draining_sandbox_leases' THEN
          'IF NOT EXISTS (SELECT 1 FROM opengeni_private.maintenance_probe_sandbox_leases WHERE liveness=''draining'') THEN RETURN; END IF;'
        ELSE '' END);
    EXECUTE header || ' LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS ' || quote_literal(body);
  END LOOP;
END $wrappers$;

-- Deferred consistency checks run after the claim/settlement token is gone.
-- Each trigger gets its own read-only operation token, discarded before return.
DO $validators$
DECLARE name text; routine record; rewritten text; data_schema text := current_schema(); source_name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['validate_sandbox_checkpoint_refs','validate_sandbox_checkpoint_artifact_refs'] LOOP
    SELECT p.*,pg_get_functiondef(p.oid) AS definition INTO STRICT routine FROM pg_proc p
      WHERE p.oid=('opengeni_private.'||name||'()')::regprocedure;
    IF position('RETURN NEW;' in routine.prosrc)=0 THEN RAISE EXCEPTION 'checkpoint validator shape drift: %',name; END IF;
    rewritten := replace(routine.prosrc,'RETURN NEW;',
      'DELETE FROM opengeni_private.maintenance_claim_capabilities c WHERE c.id=maintenance_capability_id; RETURN NEW;');
    source_name := CASE name WHEN 'validate_sandbox_checkpoint_refs' THEN 'sandbox_leases' ELSE 'sandbox_checkpoint_artifacts' END;
    rewritten := 'DECLARE maintenance_capability_id uuid := gen_random_uuid(); BEGIN '
      || format('IF TG_RELID <> %L::regclass THEN RAISE EXCEPTION ''invalid checkpoint validator source'' USING ERRCODE=''42501''; END IF; ',format('%I.%I',data_schema,source_name))
      || 'INSERT INTO opengeni_private.maintenance_claim_capabilities VALUES (maintenance_capability_id,pg_backend_pid(),pg_current_xact_id(),''checkpoint_validate''); '
      || rewritten || ' EXCEPTION WHEN OTHERS THEN DELETE FROM opengeni_private.maintenance_claim_capabilities c WHERE c.id=maintenance_capability_id; RAISE; END';
    EXECUTE replace(routine.definition,routine.prosrc,rewritten);
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.%I() FROM PUBLIC',name);
  END LOOP;
END $validators$;
