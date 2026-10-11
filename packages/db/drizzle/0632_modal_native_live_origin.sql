-- deployment-mode: rolling
-- Inert exact-origin projection. Trusted-server SQL privilege is NOT host
-- authentication. No grant, lease, provider operation, wake or custody is minted.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE IF NOT EXISTS opengeni_private.modal_native_origin_read_capabilities (
  capability_id uuid PRIMARY KEY,
  data_schema oid NOT NULL,
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  execution_generation integer NOT NULL CHECK (execution_generation > 0),
  initiating_human_subject_id text NOT NULL
);
ALTER TABLE opengeni_private.modal_native_origin_read_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.modal_native_origin_read_capabilities FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE opengeni_private.modal_native_origin_read_capabilities FROM PUBLIC;

DO $install$
DECLARE
  target_schema text := current_schema();
  target_oid oid := current_schema()::regnamespace;
  owner_name text := current_user;
  role_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='opengeni_private.modal_native_origin_read_capabilities'::regclass
    AND relowner=current_user::regrole) THEN
    RAISE EXCEPTION 'native origin capability owner mismatch' USING ERRCODE='55000';
  END IF;
  -- Remove hostile owner defaults; no runtime or PUBLIC table/column access.
  FOR role_name IN SELECT DISTINCT r.rolname FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    JOIN pg_roles r ON r.oid=a.grantee
    WHERE c.oid='opengeni_private.modal_native_origin_read_capabilities'::regclass
      AND a.grantee<>c.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE opengeni_private.modal_native_origin_read_capabilities FROM %I',role_name);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='opengeni_private.modal_native_origin_read_capabilities'::regclass
    AND polname='owner_only') THEN
    EXECUTE format('CREATE POLICY owner_only ON opengeni_private.modal_native_origin_read_capabilities
      USING (current_user=%L) WITH CHECK (current_user=%L)',owner_name,owner_name);
  END IF;

  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.modal_native_origin_member_read_active(p_account uuid,p_subject text)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$
      SELECT EXISTS (SELECT 1 FROM opengeni_private.modal_native_origin_read_capabilities c
        WHERE c.data_schema=%2$s::oid AND c.backend_pid=pg_backend_pid()
          AND c.transaction_id=pg_current_xact_id_if_assigned()
          AND c.account_id=p_account AND c.initiating_human_subject_id=p_subject)
    $body$;
    REVOKE ALL ON FUNCTION %1$I.modal_native_origin_member_read_active(uuid,text) FROM PUBLIC;
    CREATE POLICY modal_native_origin_member_read ON %1$I.organization_memberships FOR SELECT
      USING (current_user=%3$L AND %1$I.modal_native_origin_member_read_active(account_id,subject_id));
  $ddl$,target_schema,target_oid,owner_name);

  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.lock_live_native_original_origin_v2(p_scope jsonb)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
    SET search_path=pg_catalog,%1$I,pg_temp AS $body$
    DECLARE
      s sessions%%ROWTYPE; t session_turns%%ROWTYPE; a session_turn_attempts%%ROWTYPE;
      m organization_memberships%%ROWTYPE; control workspace_inference_controls%%ROWTYPE;
      ancestor sessions%%ROWTYPE;
      account_value uuid; workspace_value uuid; session_value uuid; turn_value uuid; attempt_value uuid;
      generation_value integer; route_value integer; member_key bigint; tenancy_key bigint;
      fenced_cap uuid; member_cap uuid; parent_value uuid; visited uuid[]; override_value bigint:=0;
      count_value integer:=0; count_json jsonb; basis text; key_name text;
      result jsonb:='{"kind":"fenced"}'::jsonb;
      keys constant text[]:=ARRAY['version','declarationId','planId','creatorId','accountId','workspaceId',
        'sessionId','turnId','attemptId','executionGeneration','triggerEventId','sandboxGroupId',
        'routeKind','routeTargetId','routeEpoch'];
    BEGIN
      IF jsonb_typeof(p_scope) IS DISTINCT FROM 'object' OR NOT p_scope ?& keys
        OR p_scope-keys<>'{}'::jsonb OR p_scope->'version'<>'2'::jsonb
        OR p_scope->'routeKind'<>'"home"'::jsonb OR p_scope->'routeTargetId'<>'null'::jsonb
      THEN RETURN '{"kind":"unsupported","reason":"invalid_scope"}'::jsonb; END IF;
      FOREACH key_name IN ARRAY ARRAY['declarationId','planId','creatorId','accountId','workspaceId',
        'sessionId','turnId','attemptId','triggerEventId','sandboxGroupId'] LOOP
        IF jsonb_typeof(p_scope->key_name)<>'string' OR (p_scope->>key_name) !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN RETURN '{"kind":"unsupported","reason":"invalid_scope"}'::jsonb; END IF;
      END LOOP;
      FOREACH key_name IN ARRAY ARRAY['executionGeneration','routeEpoch'] LOOP
        IF jsonb_typeof(p_scope->key_name)<>'number' OR
          (p_scope->>key_name)::numeric<>trunc((p_scope->>key_name)::numeric) OR
          (p_scope->>key_name)::numeric NOT BETWEEN 0 AND 2147483647
        THEN RETURN '{"kind":"unsupported","reason":"invalid_scope"}'::jsonb; END IF;
      END LOOP;
      IF (p_scope->>'executionGeneration')::integer=0 OR p_scope->>'creatorId'=p_scope->>'attemptId'
        OR p_scope->>'creatorId'=p_scope->>'planId'
      THEN RETURN '{"kind":"unsupported","reason":"invalid_scope"}'::jsonb; END IF;
      account_value:=(p_scope->>'accountId')::uuid; workspace_value:=(p_scope->>'workspaceId')::uuid;
      session_value:=(p_scope->>'sessionId')::uuid; turn_value:=(p_scope->>'turnId')::uuid;
      attempt_value:=(p_scope->>'attemptId')::uuid;
      generation_value:=(p_scope->>'executionGeneration')::integer; route_value:=(p_scope->>'routeEpoch')::integer;
      IF account_value IS DISTINCT FROM opengeni_private.current_account_id()
        OR workspace_value IS DISTINCT FROM opengeni_private.current_workspace_id()
        OR nullif(current_setting('opengeni.subject_id',true),'') IS NULL
      THEN RETURN result; END IF;
      member_key:=hashtextextended('organization-membership:'||account_value::text,0);
      tenancy_key:=hashtextextended('session-tenancy:'||workspace_value::text,0);
      IF EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='advisory'
        AND l.granted AND l.classid=((tenancy_key>>32)&4294967295)::oid
        AND l.objid=(tenancy_key&4294967295)::oid AND l.objsubid=1)
        AND NOT EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='advisory'
          AND l.granted AND l.mode='ExclusiveLock' AND l.classid=((member_key>>32)&4294967295)::oid
          AND l.objid=(member_key&4294967295)::oid AND l.objsubid=1)
      THEN RAISE EXCEPTION 'native origin requires membership-before-tenancy entry' USING ERRCODE='25001'; END IF;
      PERFORM pg_advisory_xact_lock(member_key);
      PERFORM acquire_session_tenancy_fence(workspace_value);
      fenced_cap:=opengeni_private.open_session_tenancy_fenced_access(%2$s::oid);
      <<projection>>
      BEGIN
        PERFORM pg_advisory_xact_lock_shared(hashtextextended('workspace-control:'||workspace_value::text,0));
        SELECT * INTO control FROM workspace_inference_controls WHERE workspace_id=workspace_value
          AND account_id=account_value FOR SHARE;
        IF NOT FOUND THEN EXIT projection; END IF;
        PERFORM 1 FROM workspaces WHERE id=workspace_value AND account_id=account_value FOR KEY SHARE;
        IF NOT FOUND THEN EXIT projection; END IF;
        SELECT * INTO s FROM sessions WHERE id=session_value AND workspace_id=workspace_value
          AND account_id=account_value FOR NO KEY UPDATE;
        IF NOT FOUND THEN EXIT projection; END IF;
        PERFORM 1 FROM session_event_cursors WHERE workspace_id=workspace_value AND session_id=session_value FOR UPDATE;
        IF NOT FOUND THEN EXIT projection; END IF;
        SELECT * INTO t FROM session_turns WHERE id=turn_value AND workspace_id=workspace_value
          AND account_id=account_value AND session_id=session_value FOR UPDATE;
        IF NOT FOUND THEN EXIT projection; END IF;
        SELECT * INTO a FROM session_turn_attempts WHERE id=attempt_value AND workspace_id=workspace_value
          AND account_id=account_value AND session_id=session_value AND turn_id=turn_value FOR UPDATE;
        IF NOT FOUND THEN EXIT projection; END IF;
        IF s.status<>'running' OR s.admission_block IS NOT NULL OR s.active_turn_id IS DISTINCT FROM turn_value
          OR t.status<>'running' OR t.active_attempt_id IS DISTINCT FROM attempt_value
          OR t.execution_generation<>generation_value OR a.execution_generation<>generation_value
          OR t.trigger_event_id<>(p_scope->>'triggerEventId')::uuid
          OR s.sandbox_group_id<>(p_scope->>'sandboxGroupId')::uuid
          OR s.active_sandbox_id IS NOT NULL OR s.active_epoch<>route_value
          OR a.state NOT IN ('claimed','running') OR a.outcome IS NOT NULL
          OR a.closed_at IS NOT NULL OR a.quiesced_at IS NOT NULL
          OR a.authority_epoch IS NULL OR a.authority_visibility IS NULL
          OR a.authority_epoch NOT BETWEEN s.execution_authority_epoch AND s.authority_epoch
          OR NOT (a.authority_visibility=s.visibility OR (a.authority_visibility='user_private'
            AND s.visibility='workspace_shared' AND a.authority_epoch<s.authority_epoch))
          OR a.authority_owner_organization_membership_id IS DISTINCT FROM s.owner_organization_membership_id
          OR (a.authority_visibility='user_private' AND a.authority_owner_organization_membership_id IS NULL)
          OR EXISTS (SELECT 1 FROM session_attempt_interruptions i WHERE i.workspace_id=workspace_value
            AND i.session_id=session_value AND i.attempt_id=attempt_value AND i.state IN ('pending','delivered','acknowledged'))
        THEN EXIT projection; END IF;
        -- Same override ordering as projectEffectiveControl; control SHARE
        -- serializes all ancestry control writes, including Pause/Resume/Cancel.
        ancestor:=s; visited:=ARRAY[]::uuid[];
        LOOP
          IF ancestor.id=ANY(visited) OR cardinality(visited)>10000 THEN EXIT projection; END IF;
          visited:=array_append(visited,ancestor.id);
          IF ancestor.direct_control_state='paused' AND
            (ancestor.direct_pause_revision IS NULL OR override_value<=ancestor.direct_pause_revision)
          THEN EXIT projection; END IF;
          override_value:=greatest(override_value,coalesce(ancestor.subtree_run_override_revision,0));
          parent_value:=ancestor.parent_session_id;
          EXIT WHEN parent_value IS NULL;
          SELECT * INTO ancestor FROM sessions WHERE id=parent_value AND workspace_id=workspace_value AND account_id=account_value;
          IF NOT FOUND THEN EXIT projection; END IF;
        END LOOP;
        IF control.workspace_state='paused' AND
          (control.workspace_pause_revision IS NULL OR override_value<=control.workspace_pause_revision)
        THEN EXIT projection; END IF;
        IF EXISTS (SELECT 1 FROM session_pending_tool_calls WHERE workspace_id=workspace_value AND session_id=session_value)
          OR EXISTS (SELECT 1 FROM agent_run_states WHERE workspace_id=workspace_value AND session_id=session_value AND turn_id=turn_value)
          -- claimTurnAttempt publishes turn.started before establishTurnSandbox.
          -- It is lifecycle truth, not evidence that a model was dispatched.
          OR EXISTS (SELECT 1 FROM session_events WHERE workspace_id=workspace_value AND session_id=session_value
            AND turn_id=turn_value AND type='agent.model.request')
        THEN result:='{"kind":"unsupported","reason":"not_premodel"}'::jsonb; EXIT projection; END IF;
        IF t.initiating_human_subject_id IS NULL OR t.initiator_subject_id='unattributed-legacy'
          OR t.initiating_human_subject_id NOT LIKE 'user:%%'
        THEN result:='{"kind":"unsupported","reason":"human_unavailable"}'::jsonb; EXIT projection; END IF;
        IF EXISTS (SELECT 1 FROM external_link_turn_authorities WHERE account_id=account_value
          AND workspace_id=workspace_value AND turn_id=turn_value)
        THEN result:='{"kind":"unsupported","reason":"external_authority"}'::jsonb; EXIT projection; END IF;
        IF jsonb_typeof(t.metadata) IS DISTINCT FROM 'object' THEN EXIT projection; END IF;
        IF t.metadata ? 'providerRecoveryCount' THEN
          count_json:=t.metadata->'providerRecoveryCount';
          IF jsonb_typeof(count_json) IS DISTINCT FROM 'number' THEN EXIT projection; END IF;
          IF count_json::numeric<>trunc(count_json::numeric) OR count_json::numeric NOT BETWEEN 0 AND 5
          THEN EXIT projection; END IF;
          count_value:=count_json::integer;
        END IF;
        member_cap:=gen_random_uuid();
        INSERT INTO opengeni_private.modal_native_origin_read_capabilities VALUES
          (member_cap,%2$s::oid,pg_backend_pid(),pg_current_xact_id(),account_value,workspace_value,
           session_value,turn_value,attempt_value,generation_value,t.initiating_human_subject_id);
        SELECT * INTO m FROM organization_memberships WHERE account_id=account_value
          AND subject_id=t.initiating_human_subject_id AND status='active' AND revoked_at IS NULL;
        IF NOT FOUND THEN EXIT projection; END IF;
        IF m.personal_workspace_id=workspace_value THEN basis:='personal_workspace';
        ELSIF EXISTS (SELECT 1 FROM workspace_memberships WHERE account_id=account_value
          AND workspace_id=workspace_value AND subject_id=t.initiating_human_subject_id)
        THEN basis:='workspace_membership'; ELSE EXIT projection; END IF;
        IF s.visibility='user_private' AND (s.owner_subject_id IS DISTINCT FROM t.initiating_human_subject_id
          OR s.owner_organization_membership_id IS DISTINCT FROM m.id) THEN EXIT projection; END IF;
        result:=jsonb_build_object('kind','live','projection',jsonb_build_object(
          'version',1,'scope',p_scope,
          'initiator',jsonb_build_object('kind',t.initiator_kind,'subjectId',t.initiator_subject_id,
            'initiatingHumanSubjectId',t.initiating_human_subject_id),
          'membership',jsonb_build_object('id',m.id,'authorizationRevision',m.authorization_revision::text,'basis',basis),
          'acceptedAuthority',jsonb_build_object('epoch',a.authority_epoch,'visibility',a.authority_visibility,
            'ownerOrganizationMembershipId',a.authority_owner_organization_membership_id),
          'currentAuthority',jsonb_build_object('epoch',s.authority_epoch,'executionEpoch',s.execution_authority_epoch,
            'visibility',s.visibility,'ownerSubjectId',s.owner_subject_id,'ownerOrganizationMembershipId',s.owner_organization_membership_id),
          'control',jsonb_build_object('workspaceRevision',control.revision::text,'sessionVersion',s.control_version::text),
          'execution',jsonb_build_object('workflowId',a.temporal_workflow_id,'workflowRunId',a.temporal_workflow_run_id,
            'activityId',a.temporal_activity_id),
          'providerRecoveryCount',count_value,'checkedAt',clock_timestamp()));
      END projection;
      DELETE FROM opengeni_private.modal_native_origin_read_capabilities WHERE capability_id=member_cap;
      PERFORM opengeni_private.close_session_tenancy_fenced_access(fenced_cap);
      RETURN result;
    EXCEPTION WHEN OTHERS THEN
      -- The function's exception subtransaction rolls back its own capabilities
      -- and locks. Preserve any earlier caller capability; propagate uncertainty.
      RAISE;
    END
    $body$;
    REVOKE ALL ON FUNCTION %1$I.lock_live_native_original_origin_v2(jsonb) FROM PUBLIC;
  $ddl$,target_schema,target_oid);
  FOR role_name IN SELECT jsonb_array_elements_text(coalesce(nullif(
    current_setting('opengeni.migration_application_roles',true),'')::jsonb,'[]'::jsonb)) LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.lock_live_native_original_origin_v2(jsonb) TO %I',target_schema,role_name);
    END IF;
  END LOOP;
END
$install$;