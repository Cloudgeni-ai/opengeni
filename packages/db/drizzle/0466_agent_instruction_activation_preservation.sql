-- deployment-mode: rolling
-- Agent instruction writes are additive or localized. Older application
-- instances may still omit editMode while this migration rolls out, but their
-- complete-content request is accepted only when it contains the active
-- instruction byte-for-byte. Existing unsafe pending revisions and explicit
-- replacement revisions are fenced again at the central activation ledger.

ALTER FUNCTION agent_instruction_apply(uuid,uuid,jsonb,jsonb)
  RENAME TO agent_instruction_apply_0462_unsafe;

CREATE FUNCTION agent_instruction_apply(p_account uuid,p_workspace uuid,p_actor jsonb,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  operation text:=p_request->>'operation';
  edit_mode text;
  current_state jsonb;
  current_content text;
  requested_content text;
  old_text text;
  new_text text;
  expected_content text;
  first_position integer;
  second_position integer;
  preservation jsonb;
  effective_actor jsonb:=p_actor;
BEGIN
  IF operation='save' THEN
    -- Preserve the exact fingerprint of operations first executed by either
    -- side of this rolling boundary. New receipts carry the derived marker in
    -- their stored actor; older receipts intentionally do not.
    IF p_request->>'operationId' IS NOT NULL THEN
      SELECT op.actor->'_instructionPreservation' INTO preservation
        FROM agent_instruction_operations op
        WHERE op.account_id=p_account
          AND op.operation_id=(p_request->>'operationId')::uuid;
      IF FOUND THEN
        IF preservation IS NOT NULL THEN
          effective_actor:=p_actor||jsonb_build_object(
            '_instructionPreservation',preservation);
        END IF;
        RETURN agent_instruction_apply_0462_unsafe(
          p_account,p_workspace,effective_actor,p_request);
      END IF;
    END IF;
    current_state:=agent_instruction_apply_0462_unsafe(
      p_account,p_workspace,p_actor,
      jsonb_build_object('operation','get','target',p_request->'target'));
    current_content:=current_state->>'content';
    IF p_request ? 'editMode' THEN
      edit_mode:=p_request->>'editMode';
      IF edit_mode IS NULL OR edit_mode NOT IN ('append','edit') THEN
        RAISE EXCEPTION 'Agents cannot replace the complete workspace instruction'
          USING ERRCODE='22023';
      END IF;
      IF edit_mode='append' THEN
        requested_content:=p_request->>'content';
        expected_content:=CASE
          WHEN current_content IS NULL THEN requested_content
          WHEN right(current_content,2)=E'\n\n' THEN current_content||requested_content
          WHEN right(current_content,1)=E'\n' THEN current_content||E'\n'||requested_content
          ELSE current_content||E'\n\n'||requested_content
        END;
      ELSE
        old_text:=p_request->>'oldText';
        new_text:=p_request->>'newText';
        IF current_content IS NOT NULL AND old_text IS NOT DISTINCT FROM current_content THEN
          RAISE EXCEPTION 'Exact instruction edits must be localized; the complete instruction cannot be replaced'
            USING ERRCODE='22023';
        END IF;
        first_position:=strpos(current_content,old_text);
        IF first_position=0 THEN
          RAISE EXCEPTION 'Exact instruction edit anchor was not found' USING ERRCODE='22023';
        END IF;
        second_position:=strpos(substring(current_content FROM first_position+1),old_text);
        IF second_position>0 THEN
          RAISE EXCEPTION 'Exact instruction edit anchor is ambiguous' USING ERRCODE='22023';
        END IF;
        expected_content:=overlay(current_content PLACING new_text FROM first_position FOR length(old_text));
      END IF;
    ELSE
      -- A pre-0462 caller already constructed a complete proposed document.
      -- Preserve rolling availability for additive requests without allowing
      -- that compatibility path to discard any active byte.
      requested_content:=p_request->>'content';
      IF current_content IS NOT NULL
        AND (requested_content IS NULL OR strpos(requested_content,current_content)=0) THEN
        RAISE EXCEPTION 'Legacy instruction replacement would discard active workspace instructions'
          USING ERRCODE='22023';
      END IF;
      edit_mode:='legacy_safe';
      expected_content:=requested_content;
    END IF;
    preservation:=jsonb_strip_nulls(jsonb_build_object(
      'saveOperationId',p_request->>'operationId',
      'baselineContentHash',CASE WHEN current_content IS NULL THEN NULL
        ELSE encode(sha256(convert_to(current_content,'UTF8')),'hex') END,
      'resultContentHash',CASE WHEN expected_content IS NULL THEN NULL
        ELSE encode(sha256(convert_to(expected_content,'UTF8')),'hex') END,
      'editMode',edit_mode));
    effective_actor:=p_actor||jsonb_build_object(
      '_instructionPreservation',preservation);
  END IF;
  RETURN agent_instruction_apply_0462_unsafe(
    p_account,p_workspace,effective_actor,p_request);
END $$;

CREATE FUNCTION agent_instruction_activation_preserves_baseline()
RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  proposed workspace_instruction_policy_revisions%ROWTYPE;
  baseline_content text;
  baseline_hash text;
  proposed_hash text;
  preservation jsonb;
BEGIN
  IF NEW.type<>'activate' OR NEW.old_revision_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO proposed FROM workspace_instruction_policy_revisions r
    WHERE r.account_id=NEW.account_id AND r.workspace_id=NEW.workspace_id
      AND r.id=NEW.new_revision_id;
  IF NOT FOUND OR proposed.provenance_source<>'agent_learning' THEN RETURN NEW; END IF;
  SELECT r.content INTO baseline_content FROM workspace_instruction_policy_revisions r
    WHERE r.account_id=NEW.account_id AND r.workspace_id=NEW.workspace_id
      AND r.id=NEW.old_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The active instruction baseline is unavailable'
      USING ERRCODE='22023';
  END IF;
  -- Compatibility revisions that retain the complete baseline are safe even
  -- when they predate the wrapper-derived preservation metadata below.
  IF baseline_content IS NOT NULL AND strpos(proposed.content,baseline_content)>0 THEN
    RETURN NEW;
  END IF;
  baseline_hash:=encode(sha256(convert_to(baseline_content,'UTF8')),'hex');
  proposed_hash:=encode(sha256(convert_to(proposed.content,'UTF8')),'hex');
  preservation:=proposed.agent_learning_context#>'{actor,_instructionPreservation}';
  IF preservation->>'saveOperationId'=proposed.operation_id::text
    AND preservation->>'baselineContentHash'=baseline_hash
    AND preservation->>'resultContentHash'=proposed_hash
    AND preservation->>'editMode' IN ('append','edit','legacy_safe') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Unsafe whole-instruction agent replacement cannot be activated; reject it and create an append or localized edit'
    USING ERRCODE='22023';
END $$;

DROP TRIGGER IF EXISTS agent_instruction_activation_preservation
  ON workspace_instruction_policy_activation_events;
CREATE TRIGGER agent_instruction_activation_preservation
  BEFORE INSERT ON workspace_instruction_policy_activation_events
  FOR EACH ROW EXECUTE FUNCTION agent_instruction_activation_preserves_baseline();

DO $secure$
DECLARE grantee text; runtime_role text;
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.agent_instruction_apply_0462_unsafe(uuid,uuid,jsonb,jsonb) SET search_path = %I, pg_catalog, pg_temp',
    current_schema(),current_schema());
  EXECUTE format(
    'ALTER FUNCTION %I.agent_instruction_apply(uuid,uuid,jsonb,jsonb) SET search_path = %I, pg_catalog, pg_temp',
    current_schema(),current_schema());
  EXECUTE format(
    'ALTER FUNCTION %I.agent_instruction_activation_preserves_baseline() SET search_path = %I, pg_catalog, pg_temp',
    current_schema(),current_schema());
  REVOKE ALL ON FUNCTION agent_instruction_apply_0462_unsafe(uuid,uuid,jsonb,jsonb) FROM PUBLIC;
  REVOKE ALL ON FUNCTION agent_instruction_apply(uuid,uuid,jsonb,jsonb) FROM PUBLIC;
  REVOKE ALL ON FUNCTION agent_instruction_activation_preserves_baseline() FROM PUBLIC;
  FOR grantee IN SELECT DISTINCT role.rolname FROM pg_proc proc,
    LATERAL aclexplode(coalesce(proc.proacl,acldefault('f',proc.proowner))) acl
    JOIN pg_roles role ON role.oid=acl.grantee
    WHERE proc.pronamespace=current_schema()::regnamespace
      AND proc.proname='agent_instruction_apply_0462_unsafe'
      AND acl.grantee<>proc.proowner
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION %I.agent_instruction_apply_0462_unsafe(uuid,uuid,jsonb,jsonb) FROM %I',
      current_schema(),grantee);
  END LOOP;
  FOR runtime_role IN SELECT jsonb_array_elements_text(
    current_setting('opengeni.migration_application_roles')::jsonb)
  LOOP
    IF runtime_role<>current_user AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION %I.agent_instruction_apply_0462_unsafe(uuid,uuid,jsonb,jsonb) FROM %I',
        current_schema(),runtime_role);
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %I.agent_instruction_apply(uuid,uuid,jsonb,jsonb) TO %I',
        current_schema(),runtime_role);
    END IF;
  END LOOP;
END $secure$;
