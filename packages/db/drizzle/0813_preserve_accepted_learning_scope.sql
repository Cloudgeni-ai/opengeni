-- deployment-mode: rolling
-- Sharing preserves accepted work. Keep its frozen Personal destination rather
-- than widening it to Workspace or rejecting its next attempt/tool operation.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $repair$
DECLARE definition text;
  anchor text := $old$  policy:=knowledge_learning_for_turn(p_account,p_workspace,t.id);
  IF policy->>'defaultScope' IS DISTINCT FROM destination$old$;
  replacement text := $new$  policy:=knowledge_learning_for_turn(p_account,p_workspace,t.id);
  -- Only the same accepted human can retain Personal authority after sharing.
  -- The exact live attempt and interruption fences above still apply. Never
  -- rewrite the snapshot, widen Personal writes, or adopt another human's scope.
  IF destination='workspace' AND s.visibility='workspace_shared'
    AND policy->>'defaultScope'='personal' AND subject IS NOT NULL
    AND policy->>'subjectId'=subject THEN
    destination:='personal';
    PERFORM set_config('opengeni.knowledge_default_scope',destination,true);
    PERFORM set_config('opengeni.private_file_owner',subject,true);
  END IF;
  IF policy->>'defaultScope' IS DISTINCT FROM destination$new$;
BEGIN
  SELECT pg_get_functiondef(format('%I.knowledge_resolve_actor(uuid,uuid,jsonb)', current_schema())::regprocedure)
    INTO STRICT definition;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'knowledge_resolve_actor accepted policy anchor drifted';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END $repair$;
