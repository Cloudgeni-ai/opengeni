-- deployment-mode: maintenance
-- Drain old API/control/turn workers: old review UIs do not describe deletion.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles',true),'')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles)<>'array' OR jsonb_array_length(roles) NOT BETWEEN 1 AND 16
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(roles) r WHERE jsonb_typeof(r)<>'string' OR length(btrim(r#>>'{}')) NOT BETWEEN 1 AND 63)
  THEN RAISE EXCEPTION 'Skill removal requires explicit application database roles' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON a.usename=r.value
    WHERE a.datname=current_database() AND a.pid<>pg_backend_pid())
  THEN RAISE EXCEPTION 'Skill removal requires drained application sessions' USING ERRCODE='55000'; END IF;
END $drain$;

ALTER TABLE preference_registry_revisions ADD COLUMN IF NOT EXISTS skill_removal_operation_id uuid;
-- Keep content-free operation receipts: forgetting a create/save operation would
-- allow its delayed retry to recreate the deleted Skill. Referential cleanup
-- also reaches personal-Skill receipts written through another workspace.
ALTER TABLE skill_write_receipts DROP CONSTRAINT skill_write_receipts_activation_event_id_fkey;
ALTER TABLE skill_write_receipts ADD CONSTRAINT skill_write_receipts_activation_event_id_fkey
  FOREIGN KEY (activation_event_id) REFERENCES preference_registry_events(id) ON DELETE SET NULL;
-- No content is copied to a tombstone. Existing foreign keys remain restrictive
-- for surviving cross-scope references; removal deletes only its scoped audit
-- rows that hold live references. Content-free removal receipts remain replayable.

-- The anchored function DDL below contains DML text. Keep the owner-visible
-- window explicit for the migration guard; no table data is changed here.
ALTER TABLE capability_facet_installations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_preferences NO FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_write_receipts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE company_brain_preference_proposal_receipts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_component_owners NO FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_source_bindings NO FORCE ROW LEVEL SECURITY;
DO $patch$
DECLARE definition text; anchor text; replacement text; pair jsonb;
BEGIN
  definition := pg_get_functiondef('opengeni_private.guard_workspace_owned_skill_head_delete()'::regprocedure);
  anchor := $a$IF TG_OP <> 'DELETE' OR pg_trigger_depth() <= 1 OR OLD.scope <> 'workspace' THEN$a$;
  replacement := $r$IF TG_OP='DELETE'
    AND current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
    AND current_setting('opengeni.skill_remove_head',true)=OLD.id::text
    AND nullif(current_setting('opengeni.account_id',true),'')::uuid=OLD.account_id
    AND (OLD.scope='user' OR (OLD.scope='workspace' AND OLD.scope_workspace_id=nullif(current_setting('opengeni.workspace_id',true),'')::uuid))
  THEN RETURN OLD; END IF;
  IF TG_OP <> 'DELETE' OR pg_trigger_depth() <= 1 OR OLD.scope <> 'workspace' THEN$r$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Skill delete guard anchor mismatch'; END IF;
  EXECUTE replace(definition,anchor,replacement);

  definition := pg_get_functiondef('opengeni_private.guard_workspace_owned_skill_history_delete()'::regprocedure);
  anchor := $a$IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;$a$;
  replacement := $r$IF TG_TABLE_NAME='skill_write_receipts' AND TG_OP='UPDATE' AND pg_trigger_depth()>1 THEN
    IF OLD.activation_event_id IS NOT NULL AND NEW.activation_event_id IS NULL
      AND (to_jsonb(NEW)-'activation_event_id')=(to_jsonb(OLD)-'activation_event_id')
    THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP='DELETE'
    AND current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
    AND nullif(current_setting('opengeni.skill_remove_head',true),'') IS NOT NULL
    AND nullif(current_setting('opengeni.account_id',true),'')::uuid=OLD.account_id THEN
    IF TG_TABLE_NAME='company_brain_preference_proposal_receipts' THEN
      IF OLD.workspace_id=nullif(current_setting('opengeni.workspace_id',true),'')::uuid
        AND OLD.preference_id::text=current_setting('opengeni.skill_remove_head',true) THEN RETURN OLD; END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;$r$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Skill audit guard anchor mismatch'; END IF;
  EXECUTE replace(definition,anchor,replacement);

  definition := pg_get_functiondef('skill_guard_legacy_activation()'::regprocedure);
  anchor := 'RETURN NEW;';
  replacement := $r$IF NEW.active_revision_id IS NOT NULL AND EXISTS(
    SELECT 1 FROM preference_registry_revisions WHERE id=NEW.active_revision_id AND skill_removal_operation_id IS NOT NULL)
  THEN RAISE EXCEPTION 'A removal proposal cannot be activated as Skill content' USING ERRCODE='42501'; END IF;
  RETURN NEW;$r$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Skill activation guard anchor mismatch'; END IF;
  EXECUTE replace(definition,anchor,replacement);

  definition := pg_get_functiondef('skill_apply_lifecycle(uuid,uuid,jsonb,jsonb)'::regprocedure);
  -- Exact anchored edits preserve the existing accepted Learning/actor resolver,
  -- live attempt locks, operation replay, human proof and head/scope CAS.
  FOR pair IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    jsonb_build_array($a$'save','install','approve','reject','restore','confirm_response'$a$,
      $r$'save','install','approve','reject','restore','confirm_response','remove'$r$),
    jsonb_build_array($a$AND h.questions->0->>'label'='Save this Skill?'$a$,
      $r$AND h.questions->0->>'label'=CASE WHEN skill_review ? 'removalOperationId' THEN 'Permanently delete this Skill?' ELSE 'Save this Skill?' END$r$),
    jsonb_build_array($a$AND h.questions->0->>'helpText'='Review the complete files before saving. Saving activates this revision immediately.'$a$,
      $r$AND h.questions->0->>'helpText'=CASE WHEN skill_review ? 'removalOperationId' THEN 'This cannot be undone. All stored Skill revisions will be deleted; conversations remain unchanged.' ELSE 'Review the complete files before saving. Saving activates this revision immediately.' END$r$),
    jsonb_build_array($a$AND h.questions->0->>'prompt'='Save this exact Skill revision for this workspace?'$a$,
      $r$AND h.questions->0->>'prompt'=CASE WHEN skill_review ? 'removalOperationId' THEN 'Permanently delete this Skill and all its stored revisions?' ELSE 'Save this exact Skill revision for this workspace?' END$r$),
    jsonb_build_array($a$AND ((h.questions->0->'options'->0) - 'description')='{"id":"save","label":"Save"}'::jsonb$a$,
      $r$AND ((h.questions->0->'options'->0) - 'description')=CASE WHEN skill_review ? 'removalOperationId' THEN '{"id":"save","label":"Permanently delete"}'::jsonb ELSE '{"id":"save","label":"Save"}'::jsonb END$r$),
    jsonb_build_array($a$AND ((h.questions->0->'options'->1) - 'description')='{"id":"skip","label":"Don''t save"}'::jsonb$a$,
      $r$AND ((h.questions->0->'options'->1) - 'description')=CASE WHEN skill_review ? 'removalOperationId' THEN '{"id":"skip","label":"Keep Skill"}'::jsonb ELSE '{"id":"skip","label":"Don''t save"}'::jsonb END$r$)
  )) LOOP
    anchor:=pair->>0; replacement:=pair->>1;
    IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Skill removal lifecycle anchor mismatch: %',anchor; END IF;
    definition:=replace(definition,anchor,replacement);
  END LOOP;
  anchor := $a$  SELECT * INTO head FROM preference_registry_preferences h WHERE h.id=skill_id AND h.account_id=p_account_id FOR UPDATE;$a$;
  replacement := $r$  -- Distribution removals acquire facet/owner rows before the Skill head.
  -- NOWAIT also prevents a publication-lock/facet-lock cycle with installation.
  -- Contention aborts atomically; the caller can retry the same operation.
  IF operation='remove' OR p_request ? 'removalOperationId' THEN
    PERFORM fi.id FROM capability_facet_installations fi JOIN skill_source_bindings b
      ON b.skill_facet_id=fi.facet_id AND b.workspace_id=fi.workspace_id
      WHERE b.preference_id=skill_id AND b.account_id=p_account_id AND b.workspace_id=p_workspace_id
      ORDER BY fi.id FOR UPDATE OF fi NOWAIT;
    PERFORM o.id FROM capability_component_owners o JOIN capability_facet_installations fi ON fi.id=o.facet_installation_id
      JOIN skill_source_bindings b ON b.skill_facet_id=fi.facet_id AND b.workspace_id=fi.workspace_id
      WHERE b.preference_id=skill_id AND b.account_id=p_account_id AND b.workspace_id=p_workspace_id
      ORDER BY o.id FOR UPDATE OF o NOWAIT;
  END IF;
  SELECT * INTO head FROM preference_registry_preferences h WHERE h.id=skill_id AND h.account_id=p_account_id FOR UPDATE;$r$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Skill removal lock anchor mismatch'; END IF;
  definition:=replace(definition,anchor,replacement);
  anchor := $a$  IF outcome IS NULL THEN
    IF operation IN ('approve','restore','reject') THEN$a$;
  replacement := $r$  -- Marked proposals are never ordinary approvals/restores. The reviewer must
  -- explicitly supply the immutable removal operation id displayed by the UI.
  SELECT * INTO rev FROM preference_registry_revisions r
    WHERE r.account_id=p_account_id AND r.preference_id=skill_id
      AND r.id=(p_request->>'revisionId')::uuid;
  IF rev.skill_removal_operation_id IS NOT NULL AND operation<>'remove' THEN
    IF operation NOT IN ('approve','reject')
      OR rev.skill_removal_operation_id IS DISTINCT FROM (p_request->>'removalOperationId')::uuid THEN
      RAISE EXCEPTION 'Removal requires explicit exact deletion approval' USING ERRCODE='42501'; END IF;
    SELECT * INTO confirmation_source FROM skill_write_receipts r
      WHERE r.account_id=p_account_id AND r.workspace_id=p_workspace_id
        AND r.operation_id=rev.skill_removal_operation_id;
    IF NOT FOUND OR confirmation_source.receipt->>'outcome'<>'pending'
      OR confirmation_source.receipt#>>'{skillReview,revisionId}' IS DISTINCT FROM rev.id::text
      OR (confirmation_source.receipt#>>'{skillReview,expectedRevisionId}')::uuid IS DISTINCT FROM head.active_revision_id
      OR (confirmation_source.receipt#>>'{skillReview,expectedScopeVersion}')::integer IS DISTINCT FROM head.scope_version
      OR EXISTS(SELECT 1 FROM preference_registry_revisions r WHERE r.preference_id=skill_id AND r.revision>rev.revision)
      OR EXISTS(SELECT 1 FROM preference_registry_events e WHERE e.preference_id=skill_id AND e.new_revision_id=rev.id AND e.type='rejected')
    THEN RAISE EXCEPTION 'Skill removal proposal changed or settled' USING ERRCODE='40001'; END IF;
  ELSIF p_request ? 'removalOperationId' THEN
    RAISE EXCEPTION 'Removal approval does not match a removal proposal' USING ERRCODE='42501';
  END IF;
  IF operation='remove' OR rev.skill_removal_operation_id IS NOT NULL THEN
    IF head.scope NOT IN ('workspace','user') THEN
      RAISE EXCEPTION 'Permanent removal does not manage organization Skills' USING ERRCODE='42501'; END IF;
    IF operation='remove' THEN
      SELECT * INTO rev FROM preference_registry_revisions r WHERE r.preference_id=skill_id AND r.account_id=p_account_id
        ORDER BY r.revision DESC LIMIT 1;
      IF NOT FOUND THEN RAISE EXCEPTION 'Skill revision unavailable' USING ERRCODE='40001'; END IF;
    END IF;
    revision_id:=rev.id;
    IF operation='remove' AND mode<>'automatic' THEN
      -- A distinct immutable proposal binds the complete revision inventory.
      INSERT INTO preference_registry_revisions(account_id,preference_id,title,description,content,content_hash,
        conflict_strategy,provenance_source,provenance_source_id,trust,created_by_subject_id,
        corrects_revision_id,skill_files,skill_activation_mode,skill_removal_operation_id)
      VALUES(p_account_id,skill_id,rev.title,rev.description,rev.content,rev.content_hash,
        'override','agent',p_actor->>'attemptId','untrusted_proposal',actor_subject,
        head.active_revision_id,rev.skill_files,rev.skill_activation_mode,operation_id) RETURNING id INTO revision_id;
      outcome:='pending';
    ELSIF operation='reject' THEN
      SELECT coalesce(max(e.version),0)+1 INTO next_event FROM preference_registry_events e WHERE e.preference_id=skill_id;
      INSERT INTO preference_registry_events(account_id,preference_id,type,version,new_revision_id,actor_subject_id,reason)
        VALUES(p_account_id,skill_id,'rejected',next_event,revision_id,actor_subject,p_request->>'reason');
      outcome:='preserved';
    ELSE
      -- Shared/composite distribution cannot be silently dismantled. Direct
      -- installations are scoped to this one facet; other facets remain intact.
      IF EXISTS(SELECT 1 FROM skill_source_bindings b JOIN capability_facet_installations fi
        ON fi.facet_id=b.skill_facet_id AND fi.workspace_id=b.workspace_id
        JOIN capability_component_owners o ON o.facet_installation_id=fi.id
        WHERE b.preference_id=skill_id AND (o.owner_kind<>'direct' OR NOT o.removable)) THEN
        RAISE EXCEPTION 'Skill has another distribution owner; release it before permanent removal' USING ERRCODE='42501'; END IF;
      DELETE FROM capability_facet_installations fi USING skill_source_bindings b
        WHERE b.preference_id=skill_id AND b.account_id=p_account_id AND b.workspace_id=p_workspace_id
          AND fi.facet_id=b.skill_facet_id AND fi.account_id=p_account_id AND fi.workspace_id=p_workspace_id;
      PERFORM set_config('opengeni.skill_remove_head',skill_id::text,true);
      DELETE FROM company_brain_preference_proposal_receipts r
        WHERE r.account_id=p_account_id AND r.workspace_id=p_workspace_id AND r.preference_id=skill_id;
      DELETE FROM preference_registry_preferences WHERE id=skill_id AND account_id=p_account_id;
      PERFORM set_config('opengeni.skill_remove_head','',true);
      outcome:='applied';
    END IF;
    result:=jsonb_build_object('operationId',operation_id,'skillId',skill_id,'revisionId',revision_id,
      'outcome',outcome,'removed',outcome='applied','removedScope',head.scope,'replayed',false);
    IF outcome='pending' THEN result:=result||jsonb_build_object('pendingReason','approval','skillReview',
      jsonb_build_object('sourceOperationId',operation_id,'removalOperationId',operation_id,'skillId',skill_id,
        'revisionId',revision_id,'expectedRevisionId',head.active_revision_id,'expectedScopeVersion',head.scope_version)); END IF;
    IF operation='reject' THEN result:=result||jsonb_build_object('decision','rejected'); END IF;
    INSERT INTO skill_write_receipts(account_id,workspace_id,operation_id,fingerprint,actor,receipt)
      VALUES(p_account_id,p_workspace_id,operation_id,fingerprint,p_actor,result);
    RETURN result;
  END IF;

  IF outcome IS NULL THEN
    IF operation IN ('approve','restore','reject') THEN$r$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Skill removal branch anchor mismatch'; END IF;
  EXECUTE replace(definition,anchor,replacement);
END $patch$;
ALTER TABLE capability_facet_installations FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_events FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_write_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE company_brain_preference_proposal_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_component_owners FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_source_bindings FORCE ROW LEVEL SECURITY;