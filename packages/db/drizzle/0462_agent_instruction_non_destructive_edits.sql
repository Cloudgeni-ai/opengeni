-- deployment-mode: rolling
-- Old application instances omit editMode and retain their complete-content
-- replacement behavior. New instances require an explicit append/edit/replace
-- choice, so the normal append path cannot erase an active instruction.

CREATE OR REPLACE FUNCTION agent_instruction_apply(p_account uuid,p_workspace uuid,p_actor jsonb,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
<<instruction_change>>
DECLARE actor jsonb; mode text; operation text:=p_request->>'operation'; fingerprint text; result jsonb;
  operation_id uuid:=(p_request->>'operationId')::uuid; revision_id uuid; batch uuid; actor_subject text;
  target jsonb:=p_request->'target'; context jsonb; expected_revision uuid; expected_version bigint;
  head workspace_instruction_policy_heads%ROWTYPE; revision workspace_instruction_policy_revisions%ROWTYPE;
  -- Keep this forward CREATE OR REPLACE compilable in historical partial-replay
  -- fixtures that predate 0461. Supported deployments have the table before
  -- this function can execute; the untyped record acquires its row descriptor
  -- from the SELECT below.
  prior record; content_hash text; outcome text; link record; version bigint;
  edit_mode text; requested_content text; old_text text; new_text text; current_content text;
  resolved_content text; first_position integer; second_position integer;
BEGIN
  IF p_account IS DISTINCT FROM nullif(current_setting('opengeni.account_id',true),'')::uuid
    OR p_workspace IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id',true),'')::uuid THEN
    RAISE EXCEPTION 'Instruction changes require exact tenant scope' USING ERRCODE='42501';
  END IF;
  -- Keep the workspace identity stable without excluding unrelated FK readers.
  -- Publication serializes on the account advisory lock below before the
  -- instruction head, matching other Knowledge writers without an advisory /
  -- workspace-row lock inversion.
  PERFORM 1 FROM workspaces WHERE id=p_workspace AND account_id=p_account FOR KEY SHARE;
  actor:=knowledge_resolve_actor(p_account,p_workspace,p_actor);
  IF operation='get' THEN
    SELECT * INTO head FROM workspace_instruction_policy_heads h WHERE h.account_id=p_account AND h.workspace_id=p_workspace
      AND h.kind=target->>'kind' AND h.scope=target->>'scope' AND h.role_key IS NOT DISTINCT FROM target->>'roleKey';
    SELECT * INTO revision FROM workspace_instruction_policy_revisions r WHERE r.account_id=p_account AND r.workspace_id=p_workspace
      AND r.id=head.revision_id;
    RETURN jsonb_build_object('target',target,'expectedCurrentRevisionId',head.revision_id,
      'expectedActivationVersion',coalesce(head.activation_version,(SELECT max(d.activation_version)
        FROM workspace_instruction_policy_deactivation_events d WHERE d.account_id=p_account AND d.workspace_id=p_workspace
          AND d.kind=target->>'kind' AND d.scope=target->>'scope' AND d.role_key IS NOT DISTINCT FROM target->>'roleKey'),0),
      'content',revision.content);
  END IF;
  IF operation='save' THEN
    IF actor->>'kind'<>'agent' OR (actor->>'defaultScope'='personal' AND get_workspace_kind(p_account,p_workspace)<>'personal') THEN
      RAISE EXCEPTION 'Workspace instructions require a workspace agent context' USING ERRCODE='42501';
    END IF;
    mode:=actor#>>'{policy,effective,instructions}';
    IF mode NOT IN ('automatic','review_first') OR mode IS NULL THEN
      RAISE EXCEPTION 'Instruction learning is Off' USING ERRCODE='42501';
    END IF;
    actor_subject:='service:agent-learning:'||(p_actor->>'attemptId');
  ELSE
    IF actor->>'kind'<>'human' OR NOT coalesce((p_actor->'settingsScopes') ? 'workspace',false) THEN
      RAISE EXCEPTION 'Instruction review requires workspace administration' USING ERRCODE='42501';
    END IF;
    actor_subject:=actor->>'subjectId';
  END IF;
  IF operation='list' THEN
    RETURN (SELECT coalesce(jsonb_agg(item ORDER BY identity),'[]'::jsonb) FROM (
      SELECT r.id AS identity,jsonb_build_object('revisionId',r.id,'target',jsonb_build_object('kind',r.kind,'scope',r.scope,'roleKey',r.role_key),
        'content',r.content,'createdAt',r.created_at,'reviewBatchId',knowledge_instruction_context(r)->'reviewBatchId',
        'sessionId',knowledge_instruction_context(r)#>'{actor,sessionId}','reason',knowledge_instruction_context(r)->'reason') AS item
      FROM workspace_instruction_policy_revisions r WHERE r.account_id=p_account AND r.workspace_id=p_workspace
        AND knowledge_instruction_context(r) IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM workspace_instruction_policy_activation_events ev WHERE ev.account_id=p_account
          AND ev.workspace_id=p_workspace AND ev.new_revision_id=r.id)
        AND NOT EXISTS(SELECT 1 FROM agent_instruction_operations op WHERE op.account_id=p_account AND op.revision_id=r.id
          AND op.receipt->>'outcome' IN ('published','rejected'))
        AND NOT EXISTS(SELECT 1 FROM workspace_instruction_policy_revisions newer WHERE newer.account_id=p_account
          AND newer.workspace_id=p_workspace AND newer.kind=r.kind AND newer.scope=r.scope
          AND newer.role_key IS NOT DISTINCT FROM r.role_key AND newer.revision>r.revision)
        AND (NOT(p_request ? 'cursor') OR r.id>(p_request->>'cursor')::uuid)
      ORDER BY r.id LIMIT 51) visible);
  END IF;
  IF operation_id IS NULL OR operation NOT IN ('save','approve','reject') OR length(btrim(p_request->>'reason')) NOT BETWEEN 1 AND 4096 THEN
    RAISE EXCEPTION 'Invalid instruction change' USING ERRCODE='22023';
  END IF;
  IF operation='save' THEN
    -- Calls from pre-0462 application instances carry complete replacement
    -- content and omit editMode. Preserve that rolling-deployment contract.
    edit_mode:=CASE WHEN p_request ? 'editMode' THEN p_request->>'editMode' ELSE 'replace' END;
    IF edit_mode NOT IN ('append','edit','replace') THEN
      RAISE EXCEPTION 'Invalid instruction edit mode' USING ERRCODE='22023';
    END IF;
    IF edit_mode IN ('append','replace') THEN
      IF jsonb_typeof(p_request->'content') IS DISTINCT FROM 'string'
        OR length(p_request->>'content') NOT BETWEEN 1 AND 600
        OR length(btrim(p_request->>'content'))=0
        OR p_request ? 'oldText' OR p_request ? 'newText' THEN
        RAISE EXCEPTION 'Append and replace instruction changes require only non-empty content' USING ERRCODE='22023';
      END IF;
      requested_content:=p_request->>'content';
    ELSE
      IF p_request ? 'content'
        OR jsonb_typeof(p_request->'oldText') IS DISTINCT FROM 'string'
        OR jsonb_typeof(p_request->'newText') IS DISTINCT FROM 'string'
        OR length(p_request->>'oldText') NOT BETWEEN 1 AND 600
        OR length(p_request->>'newText')>600 THEN
        RAISE EXCEPTION 'Exact instruction edits require oldText and newText only' USING ERRCODE='22023';
      END IF;
      old_text:=p_request->>'oldText';
      new_text:=p_request->>'newText';
    END IF;
    IF jsonb_typeof(p_request->'evidence') IS DISTINCT FROM 'array' OR jsonb_array_length(p_request->'evidence')>32 THEN
      RAISE EXCEPTION 'Invalid instruction evidence' USING ERRCODE='22023';
    END IF;
  END IF;
  fingerprint:=encode(sha256(convert_to(jsonb_build_array(
    CASE WHEN p_actor->>'kind'='agent' THEN p_actor-'attemptId'-'executionGeneration' ELSE p_actor END,
    p_request)::text,'UTF8')),'hex');
  SELECT * INTO prior FROM agent_instruction_operations op WHERE op.account_id=p_account AND op.operation_id=instruction_change.operation_id;
  IF FOUND THEN
    IF prior.request_hash<>fingerprint OR prior.origin_workspace_id<>p_workspace THEN
      RAISE EXCEPTION 'Instruction operation key reused' USING ERRCODE='23505'; END IF;
    RETURN prior.receipt||jsonb_build_object('replayed',true);
  END IF;
  IF operation<>'save' THEN
    SELECT * INTO revision FROM workspace_instruction_policy_revisions r WHERE r.account_id=p_account AND r.workspace_id=p_workspace
      AND r.id=(p_request->>'revisionId')::uuid AND knowledge_instruction_context(r) IS NOT NULL;
    IF NOT FOUND OR EXISTS(SELECT 1 FROM agent_instruction_operations op WHERE op.account_id=p_account AND op.revision_id=revision.id
      AND op.receipt->>'outcome' IN ('published','rejected')) OR EXISTS(SELECT 1 FROM workspace_instruction_policy_revisions newer
      WHERE newer.account_id=p_account AND newer.workspace_id=p_workspace AND newer.kind=revision.kind AND newer.scope=revision.scope
        AND newer.role_key IS NOT DISTINCT FROM revision.role_key AND newer.revision>revision.revision) THEN
      RAISE EXCEPTION 'Instruction review is no longer current' USING ERRCODE='40001'; END IF;
    revision_id:=revision.id; context:=knowledge_instruction_context(revision);
    target:=jsonb_build_object('kind',revision.kind,'scope',revision.scope,'roleKey',revision.role_key);
    expected_revision:=(context->>'expectedCurrentRevisionId')::uuid;
    expected_version:=(context->>'expectedActivationVersion')::bigint;
    batch:=(context->>'reviewBatchId')::uuid;
    outcome:=CASE WHEN operation='approve' THEN 'published' ELSE 'rejected' END;
  ELSE
    expected_revision:=(p_request->>'expectedCurrentRevisionId')::uuid;
    expected_version:=(p_request->>'expectedActivationVersion')::bigint;
    outcome:=CASE WHEN mode='automatic' THEN 'published' ELSE 'pending' END;
    IF outcome='pending' THEN batch:=knowledge_review_batch_for_actor(p_account,p_workspace,actor); END IF;
    context:=jsonb_build_object('actor',p_actor,'policy',actor->'policy','evidence',p_request->'evidence','reason',p_request->'reason',
      'editMode',edit_mode,'expectedCurrentRevisionId',expected_revision,'expectedActivationVersion',expected_version,'reviewBatchId',batch);
  END IF;
  IF operation<>'reject' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('knowledge-publication:'||p_account,0));
  END IF;
  SELECT * INTO head FROM workspace_instruction_policy_heads h WHERE h.account_id=p_account AND h.workspace_id=p_workspace
    AND h.kind=target->>'kind' AND h.scope=target->>'scope' AND h.role_key IS NOT DISTINCT FROM target->>'roleKey' FOR UPDATE;
  version:=coalesce(head.activation_version,(SELECT max(d.activation_version) FROM workspace_instruction_policy_deactivation_events d
    WHERE d.account_id=p_account AND d.workspace_id=p_workspace AND d.kind=target->>'kind' AND d.scope=target->>'scope'
      AND d.role_key IS NOT DISTINCT FROM target->>'roleKey'),0);
  IF operation<>'reject' AND (head.revision_id IS DISTINCT FROM expected_revision OR version IS DISTINCT FROM expected_version) THEN
    RAISE EXCEPTION 'Instruction head changed; read its current baseline' USING ERRCODE='40001'; END IF;
  IF operation='save' THEN
    SELECT r.content INTO current_content FROM workspace_instruction_policy_revisions r
      WHERE r.account_id=p_account AND r.workspace_id=p_workspace AND r.id=head.revision_id;
    IF edit_mode='append' THEN
      resolved_content:=CASE
        WHEN current_content IS NULL THEN requested_content
        WHEN right(current_content,2)=E'\n\n' THEN current_content||requested_content
        WHEN right(current_content,1)=E'\n' THEN current_content||E'\n'||requested_content
        ELSE current_content||E'\n\n'||requested_content
      END;
    ELSIF edit_mode='edit' THEN
      IF current_content IS NULL THEN
        RAISE EXCEPTION 'Exact instruction edit requires an active instruction' USING ERRCODE='22023';
      END IF;
      first_position:=strpos(current_content,old_text);
      IF first_position=0 THEN
        RAISE EXCEPTION 'Exact instruction edit anchor was not found' USING ERRCODE='22023';
      END IF;
      second_position:=strpos(substring(current_content FROM first_position+1),old_text);
      IF second_position>0 THEN
        RAISE EXCEPTION 'Exact instruction edit anchor is ambiguous' USING ERRCODE='22023';
      END IF;
      resolved_content:=overlay(current_content PLACING new_text FROM first_position FOR length(old_text));
    ELSE
      resolved_content:=requested_content;
    END IF;
    IF length(resolved_content) NOT BETWEEN 1 AND 600 OR length(btrim(resolved_content))=0 THEN
      RAISE EXCEPTION 'Resulting agent-authored instruction must contain 1 to 600 characters' USING ERRCODE='22023';
    END IF;
  END IF;
  IF operation<>'reject' THEN
    FOR link IN SELECT * FROM jsonb_array_elements(context->'evidence') LOOP
      IF NOT EXISTS(SELECT 1 FROM knowledge_entries e WHERE e.account_id=p_account AND e.id=(link.value->>'entryId')::uuid
        AND NOT e.archived AND e.scope IN ('workspace','organization') AND knowledge_scope_visible(e)
        AND knowledge_revision_visible(p_account,e.id,(link.value->>'revisionId')::uuid,false)) THEN
        RAISE EXCEPTION 'Instruction evidence is unavailable to workspace readers' USING ERRCODE='42501'; END IF;
    END LOOP;
  END IF;
  IF operation='save' THEN
    content_hash:=encode(sha256(convert_to(resolved_content,'UTF8')),'hex');
    INSERT INTO workspace_instruction_policy_revisions(account_id,workspace_id,operation_id,request_fingerprint,kind,scope,role_key,
      content,content_hash,provenance_source,provenance_source_id,created_by_subject_id,supersedes_revision_id,agent_learning_context)
      VALUES(p_account,p_workspace,operation_id,fingerprint,target->>'kind',target->>'scope',target->>'roleKey',resolved_content,
        content_hash,'agent_learning',p_actor->>'attemptId',actor_subject,expected_revision,context) RETURNING * INTO revision;
    revision_id:=revision.id;
  END IF;
  IF outcome='published' THEN
    INSERT INTO workspace_instruction_policy_activation_events(account_id,workspace_id,operation_id,request_fingerprint,
      kind,scope,role_key,type,activation_version,old_revision_id,old_revision,old_content_hash,new_revision_id,new_revision,new_content_hash,
      actor_subject_id,reason)
      VALUES(p_account,p_workspace,operation_id,fingerprint,revision.kind,revision.scope,revision.role_key,'activate',version+1,
        head.revision_id,head.revision,head.content_hash,revision.id,revision.revision,revision.content_hash,actor_subject,p_request->>'reason');
    IF head.id IS NULL THEN
      INSERT INTO workspace_instruction_policy_heads(account_id,workspace_id,kind,scope,role_key,revision_id,revision,content_hash,activation_version)
        VALUES(p_account,p_workspace,revision.kind,revision.scope,revision.role_key,revision.id,revision.revision,revision.content_hash,version+1);
    ELSE
      UPDATE workspace_instruction_policy_heads h SET revision_id=revision.id,revision=revision.revision,content_hash=revision.content_hash,
        activation_version=version+1,activated_at=transaction_timestamp() WHERE h.account_id=p_account AND h.id=head.id;
    END IF;
  END IF;
  result:=jsonb_build_object('operationId',operation_id,'revisionId',revision_id,'outcome',outcome,'reviewBatchId',batch,'replayed',false);
  INSERT INTO agent_instruction_operations(account_id,origin_workspace_id,operation_id,revision_id,request_hash,actor,receipt)
    VALUES(p_account,p_workspace,operation_id,revision_id,fingerprint,p_actor,result);
  RETURN result;
END $$;
