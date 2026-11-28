-- deployment-mode: rolling
-- The direct organization backend has its own actor. Existing actors and
-- write requests retain their behavior. Do not start using the new writer
-- until the API and workers can read its provenance value.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- The new check is a strict superset, so every existing row already satisfies it.
ALTER TABLE preference_registry_revisions
  DROP CONSTRAINT preference_registry_revisions_provenance_chk,
  ADD CONSTRAINT preference_registry_revisions_provenance_chk CHECK (
    provenance_source IN ('human','onboarding','knowledge_proposal','imported_document',
      'slack','meeting_transcript','call_transcript','agent','portable_skill','organization_api_key')
    AND trust IN ('untrusted_proposal','personal','workspace_managed','organization_managed')
    AND (provenance_source_id IS NULL OR length(provenance_source_id) BETWEEN 1 AND 512)
    AND (provenance_source IN ('human','onboarding') OR provenance_source_id IS NOT NULL)
  ) NOT VALID;

DO $organization_skill_writer$
DECLARE definition text; anchor text;
BEGIN
  definition := pg_get_functiondef(format('%I.skill_apply_lifecycle(uuid,uuid,jsonb,jsonb)', current_schema())::regprocedure);
  anchor := $a$  ELSIF p_actor->>'kind' = 'service' AND operation = 'install' AND scope = 'workspace'$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN RAISE EXCEPTION 'organization Skill actor anchor drifted'; END IF;
  definition := replace(definition, anchor, $r$  ELSIF p_actor->>'kind' = 'organization_api_key'
    AND operation IN ('save','remove')
    AND (operation='remove' OR scope='organization')
    AND p_actor->>'principalKind' = 'api_key'
    AND current_setting('opengeni.principal_kind',true) = 'api_key'
    AND p_actor->>'subjectId' = nullif(current_setting('opengeni.subject_id',true),'') THEN
    -- The HTTP route proves possession of the key. Check its live account,
    -- scope, authority and revocation again before executing or replaying.
    PERFORM 1 FROM api_keys k
      WHERE k.account_id=p_account_id AND k.id=substring(p_actor->>'subjectId' FROM 9)::uuid
        AND p_actor->>'subjectId'='api_key:'||k.id::text
        AND k.credential_kind='organization' AND k.workspace_id IS NULL
        AND k.workspace_scope='all' AND k.permissions ? 'account:admin'
        AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp())
      FOR SHARE OF k;
    IF NOT FOUND THEN RAISE EXCEPTION 'Organization Skill key is not authorized' USING ERRCODE='42501'; END IF;
    actor_subject := p_actor->>'subjectId';
$r$ || anchor);

  anchor := $a$  IF p_actor->>'kind' IN ('agent','service') THEN
    learning_policy:=$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN RAISE EXCEPTION 'organization Skill learning anchor drifted'; END IF;
  definition := replace(definition, anchor, $r$  IF p_request ? 'initialReach' AND NOT (p_actor->>'kind'='organization_api_key' AND operation='save') THEN
    RAISE EXCEPTION 'Initial reach requires an organization Skill save' USING ERRCODE='42501';
  END IF;
$r$ || anchor);

  anchor := $a$    IF (p_actor->>'kind'='service' AND (head.scope<>'workspace' OR head.scope_workspace_id<>p_workspace_id))$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN RAISE EXCEPTION 'organization Skill head scope anchor drifted'; END IF;
  definition := replace(definition, anchor, $r$    IF (p_actor->>'kind'='organization_api_key' AND head.scope<>'organization')
      OR (p_actor->>'kind'='service' AND (head.scope<>'workspace' OR head.scope_workspace_id<>p_workspace_id))$r$);

  anchor := $a$    IF operation = 'install' THEN
      SELECT * INTO rev FROM preference_registry_revisions WHERE id=head.active_revision_id;$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN RAISE EXCEPTION 'organization Skill initial reach anchor drifted'; END IF;
  definition := replace(definition, anchor, $r$    IF p_request ? 'initialReach' THEN
      RAISE EXCEPTION 'Initial reach is only for a new Skill' USING ERRCODE='40001';
    END IF;
$r$ || anchor);

  anchor := $a$    IF operation NOT IN ('save','install') OR (p_request->>'expectedRevisionId') IS NOT NULL$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN RAISE EXCEPTION 'organization Skill missing head anchor drifted'; END IF;
  definition := replace(definition, anchor, $r$    IF operation='remove' AND p_actor->>'kind'='organization_api_key' THEN
      RAISE EXCEPTION 'Skill not found' USING ERRCODE='P0002';
    END IF;
$r$ || anchor);

  anchor := $a$        CASE WHEN scope='user' THEN coalesce(learning_actor->>'subjectId',actor_subject) END,actor_subject) RETURNING * INTO head;
  END IF;$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN RAISE EXCEPTION 'organization Skill reach write anchor drifted'; END IF;
  definition := replace(definition, anchor, $r$        CASE WHEN scope='user' THEN coalesce(learning_actor->>'subjectId',actor_subject) END,actor_subject) RETURNING * INTO head;
    IF p_request ? 'initialReach' THEN
      DECLARE
        reach jsonb := p_request->'initialReach';
        allowed_ids uuid[] := NULL;
        allow_personal boolean;
      BEGIN
        IF jsonb_typeof(reach->'allowPersonalWorkspaces') IS DISTINCT FROM 'boolean'
          OR coalesce(jsonb_typeof(reach->'allowedWorkspaceIds'),'missing') NOT IN ('null','array') THEN
          RAISE EXCEPTION 'Invalid initial Skill reach' USING ERRCODE='PT422';
        END IF;
        allow_personal := (reach->>'allowPersonalWorkspaces')::boolean;
        IF jsonb_typeof(reach->'allowedWorkspaceIds')='array' THEN
          IF jsonb_array_length(reach->'allowedWorkspaceIds')>500 THEN
            RAISE EXCEPTION 'Initial Skill reach exceeds 500 workspaces' USING ERRCODE='PT422';
          END IF;
          allowed_ids := ARRAY(SELECT DISTINCT item::uuid FROM jsonb_array_elements_text(reach->'allowedWorkspaceIds') item ORDER BY 1);
          IF cardinality(allowed_ids)>0 THEN
            PERFORM set_config('opengeni.workspace_id','',true);
            IF EXISTS(SELECT unnest(allowed_ids)
              EXCEPT SELECT w.workspace_id FROM list_organization_workspace_ids(p_account_id) w) THEN
              RAISE EXCEPTION 'Initial Skill reach is outside shared organization workspaces' USING ERRCODE='PT422';
            END IF;
            PERFORM set_config('opengeni.workspace_id',p_workspace_id::text,true);
          END IF;
        END IF;
        INSERT INTO organization_skill_reach(account_id,preference_id,allowed_workspace_ids,
          allow_personal_workspaces,updated_by_subject_id)
        VALUES(p_account_id,skill_id,allowed_ids,allow_personal,actor_subject);
        INSERT INTO audit_events(account_id,workspace_id,subject_id,action,target_type,target_id,metadata)
        VALUES(p_account_id,p_workspace_id,actor_subject,'skill.reach.changed','skill',skill_id::text,
          jsonb_build_object('from',NULL,'to',jsonb_build_object(
            'allowedWorkspaceIds',to_jsonb(allowed_ids),'allowPersonalWorkspaces',allow_personal)));
      END;
    END IF;
  END IF;$r$);

  anchor := $a$    IF head.scope NOT IN ('workspace','user') THEN$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN RAISE EXCEPTION 'organization Skill remove anchor drifted'; END IF;
  definition := replace(definition, anchor, $r$    IF head.scope NOT IN ('workspace','user')
      AND NOT (head.scope='organization' AND p_actor->>'kind'='organization_api_key' AND operation='remove') THEN$r$);

  anchor := $a$        'override',CASE WHEN operation='install' THEN 'portable_skill' WHEN p_actor->>'kind'='agent' THEN 'agent' ELSE 'human' END,
        CASE WHEN operation='install' THEN source_id WHEN p_actor->>'kind'='agent' THEN p_actor->>'attemptId' END,$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN RAISE EXCEPTION 'organization Skill provenance anchor drifted'; END IF;
  definition := replace(definition, anchor, $r$        'override',CASE WHEN operation='install' THEN 'portable_skill'
          WHEN p_actor->>'kind' IN ('agent','organization_api_key') THEN p_actor->>'kind' ELSE 'human' END,
        CASE WHEN operation='install' THEN source_id WHEN p_actor->>'kind'='agent' THEN p_actor->>'attemptId'
          WHEN p_actor->>'kind'='organization_api_key' THEN actor_subject END,$r$);
  EXECUTE definition;

  definition := pg_get_functiondef('opengeni_private.guard_workspace_owned_skill_head_delete()'::regprocedure);
  anchor := $a$    AND (OLD.scope='user' OR (OLD.scope='workspace' AND OLD.scope_workspace_id=nullif(current_setting('opengeni.workspace_id',true),'')::uuid))$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN RAISE EXCEPTION 'organization Skill delete trigger anchor drifted'; END IF;
  EXECUTE replace(definition, anchor, $r$    AND (OLD.scope='user'
      OR (OLD.scope='workspace' AND OLD.scope_workspace_id=nullif(current_setting('opengeni.workspace_id',true),'')::uuid)
      OR (OLD.scope='organization' AND current_setting('opengeni.principal_kind',true)='api_key'))$r$);
END
$organization_skill_writer$;

-- The legacy attempt tools also reach this reader. Filter before the descriptor
-- budget and hash; never rewrite an existing accepted snapshot or tool result.
DO $organization_skill_snapshot$
DECLARE definition text; anchor text;
BEGIN
  definition := pg_get_functiondef(format('%I.preference_registry_canonical_snapshot_at(uuid,uuid,text,timestamptz)', current_schema())::regprocedure);
  anchor := $a$    WHERE state.type IN ('activated', 'corrected')$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN RAISE EXCEPTION 'organization Skill snapshot anchor drifted'; END IF;
  definition := replace(definition, anchor, $r$    LEFT JOIN organization_skill_reach reach
      ON scope.scope='organization' AND reach.account_id=p_account_id AND reach.preference_id=preference.id
$r$ || anchor);
  anchor := $a$        scope.scope = 'organization'
        OR ($a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN RAISE EXCEPTION 'organization Skill snapshot reach anchor drifted'; END IF;
  EXECUTE replace(definition, anchor, $r$        (scope.scope='organization' AND CASE
          WHEN reach.preference_id IS NULL THEN true
          WHEN get_workspace_kind(p_account_id,p_workspace_id)='personal' THEN reach.allow_personal_workspaces
          ELSE reach.allowed_workspace_ids IS NULL OR p_workspace_id=ANY(reach.allowed_workspace_ids)
        END)
        OR ($r$);
END
$organization_skill_snapshot$;
