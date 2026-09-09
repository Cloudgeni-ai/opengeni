-- deployment-mode: maintenance
-- Exact human response admission and worker question serialization must cut over
-- together: an old API can answer a new question without activating its Skill.
-- Drain every old API/control/turn runtime and never restart a pre-0434 binary.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' OR jsonb_array_length(roles) NOT BETWEEN 1 AND 16
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(roles) r WHERE jsonb_typeof(r) <> 'string' OR length(btrim(r #>> '{}')) NOT BETWEEN 1 AND 63)
  THEN RAISE EXCEPTION '0435 requires explicit application database roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON a.usename = r.value
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid())
  THEN RAISE EXCEPTION '0435 requires drained application sessions' USING ERRCODE = '55000'; END IF;
END $drain$;

-- Historical answers receive no human-authorization proof.
ALTER TABLE session_human_input_requests
  ADD COLUMN skill_review_human_authorized boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION skill_apply_lifecycle(p_account_id uuid, p_workspace_id uuid, p_actor jsonb, p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
<<lifecycle>>
DECLARE
  actor_subject text; mode text := 'automatic'; operation text := p_request->>'operation';
  operation_id uuid := (p_request->>'operationId')::uuid;
  skill_id uuid := (p_request->>'skillId')::uuid;
  revision_id uuid; activation_event_id uuid; files jsonb := p_request->'files'; main_content text;
  head preference_registry_preferences%ROWTYPE; rev preference_registry_revisions%ROWTYPE;
  source record; binding skill_source_bindings%ROWTYPE;
  prior skill_write_receipts%ROWTYPE; result jsonb; fingerprint text;
  scope text := coalesce(p_request->>'scope','workspace'); next_event integer;
  title text := p_request->>'title'; description text := p_request->>'description';
  stable_key text := p_request->>'stableKey'; outcome text; source_id text;
  activation_mode text := 'workspace_managed';
  deferred_publication jsonb; source_effective boolean := true;
  confirmation_source skill_write_receipts%ROWTYPE;
  skill_review jsonb; initiating_human text; confirmation_generation integer;
  human_choice text;
  original_operation text := p_request->>'operation';
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id',true),'')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id',true),'')::uuid
    OR p_account_id IS NULL OR p_workspace_id IS NULL OR operation_id IS NULL
    OR operation NOT IN ('save','install','approve','restore','confirm_response') OR operation IS NULL
  THEN RAISE EXCEPTION 'Skill lifecycle requires exact tenant context' USING ERRCODE='42501'; END IF;
  IF operation='confirm_response' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:'||p_account_id,0));
  END IF;
  PERFORM 1 FROM workspaces WHERE id=p_workspace_id AND account_id=p_account_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Skill workspace unavailable' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('skill-publication:'||p_workspace_id,0));
  IF p_actor->>'kind' = 'agent' THEN
    IF scope <> 'workspace' OR operation = 'approve' THEN
      RAISE EXCEPTION 'Agents manage workspace Skills only and cannot approve' USING ERRCODE='42501'; END IF;
    PERFORM 1 FROM sessions s JOIN session_turns t ON t.id=s.active_turn_id AND t.session_id=s.id
      JOIN session_turn_attempts a ON a.id=t.active_attempt_id AND a.turn_id=t.id
      WHERE s.id=(p_actor->>'sessionId')::uuid AND s.account_id=p_account_id AND s.workspace_id=p_workspace_id
        AND t.id=(p_actor->>'turnId')::uuid AND t.account_id=p_account_id AND t.workspace_id=p_workspace_id
        AND t.status IN ('running','requires_action','recovering','waiting_capacity')
        AND a.id=(p_actor->>'attemptId')::uuid AND a.account_id=p_account_id AND a.workspace_id=p_workspace_id
        AND a.session_id=s.id AND a.execution_generation=(p_actor->>'executionGeneration')::integer
        AND t.execution_generation=a.execution_generation AND a.state IN ('claimed','running')
        AND NOT EXISTS (SELECT 1 FROM session_attempt_interruptions i WHERE i.workspace_id=p_workspace_id
          AND i.attempt_id=a.id AND i.state IN ('pending','delivered','acknowledged'))
      FOR SHARE OF s,t,a;
    IF NOT FOUND THEN RAISE EXCEPTION 'Skill write requires exact live attempt' USING ERRCODE='42501'; END IF;
    actor_subject := 'service:skill-attempt:' || (p_actor->>'attemptId');
  ELSIF p_actor->>'kind' = 'human' AND p_actor->>'principalKind' = 'human_session'
    AND p_actor->>'subjectId' = nullif(current_setting('opengeni.subject_id',true),'')
    AND current_setting('opengeni.principal_kind',true) = 'human_session' THEN
    actor_subject := p_actor->>'subjectId';
  ELSIF p_actor->>'kind' = 'service' AND operation = 'install' AND scope = 'workspace'
    AND p_actor->>'principalKind' IN ('service','api_key','configured_key')
    AND p_actor->>'subjectId' = nullif(current_setting('opengeni.subject_id',true),'')
    AND p_actor->>'principalKind' = current_setting('opengeni.principal_kind',true) THEN
    actor_subject := p_actor->>'subjectId';
  ELSE RAISE EXCEPTION 'Skill lifecycle actor is not authorized' USING ERRCODE='42501'; END IF;

  IF operation='confirm_response' THEN
    IF p_actor->>'kind' <> 'human' THEN
      RAISE EXCEPTION 'Skill chat confirmation requires verified human response admission' USING ERRCODE='42501';
    END IF;
    SELECT * INTO confirmation_source FROM skill_write_receipts r
      WHERE r.account_id=p_account_id AND r.workspace_id=p_workspace_id
        AND r.operation_id=(p_request->>'sourceOperationId')::uuid;
    skill_review := confirmation_source.receipt->'skillReview';
    IF NOT FOUND OR skill_review IS NULL OR confirmation_source.actor->>'kind'<>'agent'
 THEN
      RAISE EXCEPTION 'Skill confirmation source unavailable' USING ERRCODE='42501';
    END IF;
    SELECT coalesce(t.initiating_human_subject_id, CASE WHEN t.initiator_kind='subject' THEN t.initiator_subject_id END),
      t.execution_generation INTO initiating_human,confirmation_generation
      FROM session_turns t JOIN sessions session ON session.active_turn_id=t.id AND session.id=t.session_id
      JOIN session_human_input_requests response_request ON response_request.session_id=t.session_id
        AND response_request.turn_id=t.id AND response_request.account_id=p_account_id
        AND response_request.workspace_id=p_workspace_id
        AND response_request.id=(p_request->>'humanInputRequestId')::uuid
      WHERE t.id=(confirmation_source.actor->>'turnId')::uuid
        AND t.session_id=(confirmation_source.actor->>'sessionId')::uuid AND t.workspace_id=p_workspace_id
        AND t.account_id=p_account_id AND session.workspace_id=p_workspace_id AND session.account_id=p_account_id
        AND t.status IN ('running','requires_action','recovering','waiting_capacity')
      FOR SHARE OF t,session;
    IF initiating_human IS NULL OR initiating_human IS DISTINCT FROM p_actor->>'subjectId' OR NOT (
      EXISTS(SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=p_workspace_id AND m.subject_id=initiating_human)
      OR EXISTS(SELECT 1 FROM organization_memberships m WHERE m.account_id=p_account_id
        AND m.subject_id=initiating_human AND m.status='active' AND m.personal_workspace_id=p_workspace_id)
    ) OR EXISTS(SELECT 1 FROM organization_memberships m WHERE m.account_id=p_account_id
      AND m.subject_id=initiating_human AND m.status<>'active') THEN
      RAISE EXCEPTION 'Skill confirming human no longer has workspace authority' USING ERRCODE='42501';
    END IF;
    SELECT answer->'values'->>0 INTO human_choice
      FROM session_human_input_requests h
      CROSS JOIN LATERAL jsonb_array_elements(h.response->'answers') answer
      WHERE h.id=(p_request->>'humanInputRequestId')::uuid AND h.account_id=p_account_id AND h.workspace_id=p_workspace_id
        AND h.session_id=(confirmation_source.actor->>'sessionId')::uuid AND h.turn_id=(confirmation_source.actor->>'turnId')::uuid
        AND h.turn_generation >= (confirmation_source.actor->>'executionGeneration')::integer
        AND h.turn_generation <= confirmation_generation AND h.status='answered' AND h.responded_by=initiating_human
        AND h.skill_review_human_authorized AND h.allow_skip=false
        AND h.response->>'outcome'='answered'
        AND jsonb_array_length(h.questions)=1 AND jsonb_array_length(h.response->'answers')=1
        AND h.questions->0->>'id'='skill:'||(skill_review->>'revisionId')
        AND h.questions->0->>'kind'='single_select'
        AND h.questions->0->>'label'='Save this Skill?'
        AND h.questions->0->>'helpText'='Review the complete files before saving. Saving activates this revision immediately.'
        AND h.questions->0->'required'='true'::jsonb
        AND coalesce(h.questions->0->'allowOther','false'::jsonb)='false'::jsonb
        AND h.responded_at IS NOT NULL AND h.created_at >= confirmation_source.created_at
        AND (h.expires_at IS NULL OR h.responded_at <= h.expires_at)
        AND h.questions->0->>'prompt'='Save this exact Skill revision for this workspace?'
        AND h.questions->0->'skillReview'=skill_review
        AND h.questions->0->'options'='[{"id":"save","label":"Save"},{"id":"skip","label":"Don''t save"}]'::jsonb
        AND answer->>'questionId'='skill:'||(skill_review->>'revisionId')
        AND answer->'values' IN ('["save"]'::jsonb,'["skip"]'::jsonb)
      FOR SHARE OF h;
    IF NOT FOUND THEN RAISE EXCEPTION 'Exact human Skill confirmation unavailable' USING ERRCODE='42501'; END IF;
    skill_id := (skill_review->>'skillId')::uuid;
    p_request := p_request || skill_review || jsonb_build_object('operationId',operation_id,
      'reason','Approved once by the initiating human in chat');
    operation := CASE WHEN human_choice='skip' THEN 'reject' ELSE 'approve' END;
    actor_subject := initiating_human;
  END IF;
  fingerprint := encode(sha256(convert_to(jsonb_build_array(p_actor,p_request)::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('skill-operation:'||p_workspace_id||':'||operation_id,0));
  SELECT * INTO prior FROM skill_write_receipts r WHERE r.workspace_id=p_workspace_id AND r.operation_id=lifecycle.operation_id;
  IF FOUND THEN
    IF prior.fingerprint <> fingerprint OR prior.account_id <> p_account_id THEN
      RAISE EXCEPTION 'Skill operation key reused with different input' USING ERRCODE='23505'; END IF;
    RETURN (prior.receipt - 'portableInstall' - 'deferredPublication') || jsonb_build_object('replayed',true);
  END IF;
  IF p_actor->>'kind' IN ('agent','service') THEN
    SELECT r.workspace_mode INTO mode FROM workspace_learning_policy_heads h
      JOIN workspace_learning_policy_revisions r ON r.id=h.revision_id AND r.account_id=h.account_id
      WHERE h.account_id=p_account_id AND h.workspace_id=p_workspace_id FOR SHARE OF h;
    mode := coalesce(mode,'suggest');
    IF mode = 'off' THEN RAISE EXCEPTION 'Learning is Off; durable Skill changes are refused' USING ERRCODE='42501'; END IF;
  END IF;

  IF original_operation='confirm_response' THEN mode := 'automatic'; END IF;

  IF operation = 'install' THEN
    SELECT f.facet_key, f.activation_mode, v.plugin_id, sf.*, coalesce(jsonb_agg(jsonb_build_object('path',ff.path,'content',ff.content) ORDER BY ff.path COLLATE "C")
      FILTER (WHERE ff.id IS NOT NULL),'[]'::jsonb) AS files INTO source
      FROM capability_skill_facets sf JOIN capability_facets f ON f.id=sf.facet_id
      JOIN capability_plugin_versions v ON v.id=f.plugin_version_id
      JOIN capability_plugin_installations i ON i.plugin_version_id=v.id AND i.plugin_id=v.plugin_id
      JOIN capability_facet_installations fi ON fi.plugin_installation_id=i.id AND fi.facet_id=f.id AND fi.status='active'
      LEFT JOIN capability_skill_files ff ON ff.skill_facet_id=sf.facet_id
      WHERE sf.facet_id=(p_request->>'skillFacetId')::uuid AND i.account_id=p_account_id
        AND i.workspace_id=p_workspace_id AND i.status='active'
      GROUP BY f.facet_key,f.activation_mode,v.plugin_id,sf.facet_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Skill source is not installed in this workspace' USING ERRCODE='42501'; END IF;
    source_effective := skill_source_has_effective_owner(p_account_id,p_workspace_id,source.facet_id);
    PERFORM pg_advisory_xact_lock(hashtextextended('skill-source:'||p_workspace_id||':'||source.plugin_id||':'||source.facet_key,0));
    SELECT * INTO binding FROM skill_source_bindings b WHERE b.workspace_id=p_workspace_id
      AND b.plugin_id=source.plugin_id AND b.facet_key=source.facet_key;
    skill_id := coalesce(binding.preference_id,gen_random_uuid());
    files := source.files; title := p_request->>'title'; description := p_request->>'description';
    stable_key := 'installed-'||replace(skill_id::text,'-',''); source_id := source.facet_id::text;
    activation_mode := source.activation_mode;
  END IF;
  SELECT * INTO head FROM preference_registry_preferences h WHERE h.id=skill_id AND h.account_id=p_account_id FOR UPDATE;
  IF FOUND THEN
    scope := head.scope;
    IF operation <> 'install' THEN
      SELECT coalesce(r.skill_activation_mode,'workspace_managed') INTO activation_mode
        FROM preference_registry_revisions r WHERE r.preference_id=head.id
        ORDER BY (r.id=head.active_revision_id) DESC NULLS LAST,r.revision DESC LIMIT 1;
    END IF;
    IF (p_actor->>'kind' IN ('agent','service') AND (head.scope <> 'workspace' OR head.scope_workspace_id <> p_workspace_id))
      OR (p_actor->>'kind' = 'human' AND NOT opengeni_private.preference_registry_scope_visible(
        head.account_id,head.scope,head.scope_workspace_id,head.scope_subject_id)) THEN
      RAISE EXCEPTION 'Skill is outside authorized scope' USING ERRCODE='42501'; END IF;
    IF operation = 'install' THEN
      SELECT * INTO rev FROM preference_registry_revisions WHERE id=head.active_revision_id;
      IF head.active_revision_id IS NOT NULL AND (rev.provenance_source <> 'portable_skill' OR rev.provenance_source_id=source_id) THEN
        revision_id := head.active_revision_id; outcome := 'preserved';
      END IF;
    ELSIF head.active_revision_id IS DISTINCT FROM (p_request->>'expectedRevisionId')::uuid
      OR head.scope_version IS DISTINCT FROM (p_request->>'expectedScopeVersion')::integer THEN
      RAISE EXCEPTION 'Skill head changed' USING ERRCODE='40001';
    END IF;
    IF head.status IN ('rejected','superseded') THEN RAISE EXCEPTION 'Skill head is retired' USING ERRCODE='23514'; END IF;
  ELSE
    IF operation NOT IN ('save','install') OR (p_request->>'expectedRevisionId') IS NOT NULL
      OR (operation='save' AND (p_request->>'expectedScopeVersion')::integer IS DISTINCT FROM 1) THEN
      RAISE EXCEPTION 'Skill head missing or changed' USING ERRCODE='40001'; END IF;
    INSERT INTO preference_registry_preferences(id,account_id,stable_key,scope,scope_workspace_id,scope_subject_id,created_by_subject_id)
      VALUES(skill_id,p_account_id,stable_key,scope,CASE WHEN scope='workspace' THEN p_workspace_id END,
        CASE WHEN scope='user' THEN actor_subject END,actor_subject) RETURNING * INTO head;
  END IF;

  IF outcome IS NULL THEN
    IF operation IN ('approve','restore','reject') THEN
      SELECT * INTO rev FROM preference_registry_revisions r WHERE r.id=(p_request->>'revisionId')::uuid
        AND r.account_id=p_account_id AND r.preference_id=skill_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Skill revision unavailable' USING ERRCODE='42501'; END IF;
      IF original_operation='confirm_response' AND EXISTS(SELECT 1 FROM preference_registry_revisions newer
        WHERE newer.preference_id=skill_id AND newer.revision>rev.revision) THEN
        RAISE EXCEPTION 'Skill changed after chat proposal' USING ERRCODE='40001';
      END IF;
      IF original_operation='confirm_response' AND (
        (operation='reject' AND rev.id=head.active_revision_id)
        OR EXISTS(SELECT 1 FROM preference_registry_events event
          WHERE event.preference_id=skill_id AND event.new_revision_id=rev.id AND event.type='rejected')
      ) THEN RAISE EXCEPTION 'Skill proposal was already settled' USING ERRCODE='40001'; END IF;
      files := coalesce(rev.skill_files,jsonb_build_array(jsonb_build_object('path','SKILL.md','content',rev.content)));
      title := p_request->>'title'; description := p_request->>'description';
      activation_mode := coalesce(rev.skill_activation_mode,'workspace_managed');
      IF operation='approve' AND rev.provenance_source='portable_skill' AND EXISTS(
        SELECT 1 FROM skill_source_bindings b WHERE b.preference_id=skill_id AND b.account_id=p_account_id
          AND NOT skill_source_has_effective_owner(p_account_id,b.workspace_id,rev.provenance_source_id::uuid)) THEN
        RAISE EXCEPTION 'Skill approval requires a finalized source owner' USING ERRCODE='42501';
      END IF;
    END IF;
    IF NOT skill_files_valid(files) THEN RAISE EXCEPTION 'Invalid Skill text folder' USING ERRCODE='22023'; END IF;
    SELECT f->>'content' INTO main_content FROM jsonb_array_elements(files) f WHERE f->>'path'='SKILL.md';
    IF operation IN ('approve','reject') THEN revision_id := rev.id;
    ELSE
      INSERT INTO preference_registry_revisions(account_id,preference_id,title,description,content,content_hash,
        conflict_strategy,provenance_source,provenance_source_id,trust,created_by_subject_id,corrects_revision_id,skill_files,skill_activation_mode)
      VALUES(p_account_id,skill_id,title,description,main_content,encode(sha256(convert_to(main_content,'UTF8')),'hex'),
        'override',CASE WHEN operation='install' THEN 'portable_skill' WHEN p_actor->>'kind'='agent' THEN 'agent' ELSE 'human' END,
        CASE WHEN operation='install' THEN source_id WHEN p_actor->>'kind'='agent' THEN p_actor->>'attemptId' END,
        CASE WHEN p_actor->>'kind' IN ('agent','service') THEN 'untrusted_proposal' WHEN scope='user' THEN 'personal'
          WHEN scope='organization' THEN 'organization_managed' ELSE 'workspace_managed' END,
        actor_subject,head.active_revision_id,files,activation_mode) RETURNING id INTO revision_id;
    END IF;
    SELECT coalesce(max(e.version),0)+1 INTO next_event FROM preference_registry_events e WHERE e.preference_id=skill_id;
    IF next_event=1 THEN
      INSERT INTO preference_registry_events(account_id,preference_id,type,version,new_revision_id,new_scope,new_workspace_id,new_subject_id,actor_subject_id,reason)
      VALUES(p_account_id,skill_id,'proposal_created',next_event,revision_id,head.scope,head.scope_workspace_id,head.scope_subject_id,actor_subject,p_request->>'reason');
      next_event := next_event+1;
    END IF;
    IF mode='automatic' AND operation='install' AND NOT source_effective THEN
      deferred_publication := jsonb_build_object('expectedRevisionId',head.active_revision_id,
        'expectedScopeVersion',head.scope_version,'sourceFacetId',source.facet_id);
    END IF;
    IF operation='reject' THEN
      INSERT INTO preference_registry_events(account_id,preference_id,type,version,new_revision_id,actor_subject_id,reason)
        VALUES(p_account_id,skill_id,'rejected',next_event,revision_id,actor_subject,'Declined by the initiating human in chat');
      outcome := 'preserved';
    ELSIF mode='automatic' AND deferred_publication IS NULL THEN
      PERFORM set_config('opengeni.preference_lifecycle_head_id',skill_id::text,true);
      PERFORM set_config('opengeni.preference_lifecycle_operation','activate',true);
      UPDATE preference_registry_preferences h SET status='active',active_revision_id=revision_id,
        active_revision=r.revision,active_content_hash=r.content_hash,activation_version=h.activation_version+1,updated_at=clock_timestamp()
        FROM preference_registry_revisions r WHERE h.id=skill_id AND r.id=revision_id;
      INSERT INTO preference_registry_events(account_id,preference_id,type,version,old_revision_id,new_revision_id,actor_subject_id,reason)
        VALUES(p_account_id,skill_id,'activated',next_event,head.active_revision_id,revision_id,actor_subject,p_request->>'reason') RETURNING id INTO activation_event_id;
      outcome := 'applied';
    ELSE outcome := 'pending'; END IF;
    IF operation='install' THEN
      INSERT INTO skill_source_bindings VALUES(p_account_id,p_workspace_id,source.plugin_id,source.facet_key,skill_id,source.facet_id)
      ON CONFLICT(workspace_id,plugin_id,facet_key) DO UPDATE SET skill_facet_id=excluded.skill_facet_id;
    END IF;
  END IF;
  IF operation='install' AND outcome='preserved' THEN
    UPDATE skill_source_bindings b SET skill_facet_id=source.facet_id
      WHERE b.workspace_id=p_workspace_id AND b.plugin_id=source.plugin_id AND b.facet_key=source.facet_key;
  END IF;
  result := jsonb_build_object('operationId',operation_id,'skillId',skill_id,'revisionId',revision_id,'outcome',outcome,'replayed',false);
  IF operation='reject' THEN result := result || jsonb_build_object('decision','rejected'); END IF;
  IF outcome='pending' AND deferred_publication IS NULL AND p_actor->>'kind'='agent' THEN
    result := result || jsonb_build_object('pendingReason','approval','skillReview',
      jsonb_build_object('sourceOperationId',operation_id,'skillId',skill_id,'revisionId',revision_id,
        'expectedRevisionId',head.active_revision_id,'expectedScopeVersion',head.scope_version));
  END IF;
  IF deferred_publication IS NOT NULL THEN result := result || jsonb_build_object('pendingReason','source_finalization'); END IF;
  INSERT INTO skill_write_receipts(account_id,workspace_id,operation_id,fingerprint,actor,receipt,activation_event_id)
    VALUES(p_account_id,p_workspace_id,operation_id,fingerprint,p_actor,
      (CASE WHEN operation='install' AND p_request ? 'portableInstall'
        THEN result || jsonb_build_object('portableInstall',p_request->'portableInstall') ELSE result END)
      || CASE WHEN deferred_publication IS NOT NULL THEN jsonb_build_object('deferredPublication',deferred_publication) ELSE '{}'::jsonb END,
      activation_event_id);
  RETURN result;
END $body$;

DO $secure$
BEGIN
  EXECUTE format('ALTER FUNCTION skill_apply_lifecycle(uuid,uuid,jsonb,jsonb) SET search_path = %I, pg_catalog, pg_temp',current_schema());
  REVOKE ALL ON FUNCTION skill_apply_lifecycle(uuid,uuid,jsonb,jsonb) FROM PUBLIC;
END $secure$;
