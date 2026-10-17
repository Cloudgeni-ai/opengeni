-- deployment-mode: rolling
-- An agent whose chat learns for its person (a private chat, or a chat using
-- personal memory) may explicitly save to the workspace: a workspace Skill,
-- or a workspace instruction. Its accepted Personal default is unchanged; only
-- an explicit choice reaches the workspace. Such a change is bounded by the
-- stricter of the chat's own mode and the workspace's mode for that category,
-- both resolved as of the work's acceptance, so Off refuses and Review first
-- leaves a pending proposal for the workspace's review. The authority is the
-- same exact live attempt a shared chat's agent uses in this workspace.
-- Previous binaries never send an explicit Skill scope, so they only gain the
-- by-id workspace Skill edit and the instruction proposal. Permanently
-- deleting a workspace Skill stays with shared chats and people: an edit keeps
-- restorable history, a removal does not.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $explicit_destination$
DECLARE definition text; anchor text; replacement text;
BEGIN
  SELECT pg_get_functiondef(format('%I.skill_apply_lifecycle(uuid,uuid,jsonb,jsonb)', current_schema())::regprocedure)
    INTO STRICT definition;

  -- 1. The destination: the accepted default, or an explicit Workspace scope.
  anchor := $a$    scope:=CASE WHEN learning_actor->>'defaultScope'='personal' THEN 'user' ELSE 'workspace' END;
    IF operation IN ('approve','reject') OR (scope='user' AND operation='install') THEN$a$;
  replacement := $r$    scope:=CASE WHEN learning_actor->>'defaultScope'='personal' THEN 'user' ELSE 'workspace' END;
    -- A personal-learning agent may explicitly choose the workspace. No other
    -- destination is selectable: a shared chat has no person to save for.
    IF p_request ? 'scope' AND p_request->>'scope' IS DISTINCT FROM scope THEN
      IF NOT (scope='user' AND p_request->>'scope'='workspace') THEN
        RAISE EXCEPTION 'Skill scope is not available to this chat' USING ERRCODE='42501'; END IF;
      scope:='workspace';
    END IF;
    IF operation IN ('approve','reject') OR (learning_actor->>'defaultScope'='personal' AND operation='install') THEN$r$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'skill_apply_lifecycle destination anchor drifted';
  END IF;
  definition := replace(definition, anchor, replacement);

  -- 2. Changing (not removing) an existing workspace Skill by its id is that
  -- explicit choice.
  anchor := $a$    IF p_actor->>'kind'='agent' AND head.scope<>scope THEN
      RAISE EXCEPTION 'Skill outside accepted learning scope' USING ERRCODE='42501'; END IF;$a$;
  replacement := $r$    IF p_actor->>'kind'='agent' AND head.scope<>scope THEN
      IF p_request ? 'scope' THEN
        RAISE EXCEPTION 'Skill scope differs from the requested scope' USING ERRCODE='42501'; END IF;
      -- A personal Skill stays out of reach of a chat that does not learn for
      -- its owner; the head check below still fences another person's Skill.
      IF NOT (head.scope='workspace' AND scope='user' AND operation<>'remove') THEN
        RAISE EXCEPTION 'Skill outside accepted learning scope' USING ERRCODE='42501'; END IF;
      scope:='workspace';
    END IF;$r$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'skill_apply_lifecycle head scope anchor drifted';
  END IF;
  definition := replace(definition, anchor, replacement);

  -- 3. The workspace's own Skills mode bounds a personal chat's workspace change.
  anchor := $a$        CASE WHEN scope='user' THEN coalesce(learning_actor->>'subjectId',actor_subject) END,actor_subject) RETURNING * INTO head;
  END IF;$a$;
  replacement := $r$        CASE WHEN scope='user' THEN coalesce(learning_actor->>'subjectId',actor_subject) END,actor_subject) RETURNING * INTO head;
  END IF;
  IF p_actor->>'kind'='agent' AND learning_actor->>'defaultScope'='personal' AND scope='workspace'
    AND get_workspace_kind(p_account_id,p_workspace_id)<>'personal' THEN
    mode:=CASE WHEN mode='suggest' THEN 'review_first' ELSE mode END;
    mode:=(SELECT CASE WHEN 'off' IN (mode,m) OR m IS NULL THEN 'off'
        WHEN 'review_first' IN (mode,m) THEN 'review_first' ELSE 'automatic' END
      FROM (SELECT knowledge_learning_resolve(p_account_id,p_workspace_id,NULL,
        coalesce(learning_policy->>'contextKey','defaults'),
        coalesce((learning_policy->>'acceptedAt')::timestamptz,transaction_timestamp()))#>>'{effective,skills}' AS m) workspace_policy);
    IF mode='off' THEN RAISE EXCEPTION 'Learning is Off; durable Skill changes are refused' USING ERRCODE='42501'; END IF;
    IF mode='review_first' THEN mode:='suggest'; END IF;
  END IF;$r$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'skill_apply_lifecycle workspace mode anchor drifted';
  END IF;
  definition := replace(definition, anchor, replacement);
  EXECUTE definition;

  SELECT pg_get_functiondef(format('%I.agent_instruction_apply_0462_unsafe(uuid,uuid,jsonb,jsonb)', current_schema())::regprocedure)
    INTO STRICT definition;
  anchor := $a$    IF actor->>'kind'<>'agent' OR (actor->>'defaultScope'='personal' AND get_workspace_kind(p_account,p_workspace)<>'personal') THEN
      RAISE EXCEPTION 'Workspace instructions require a workspace agent context' USING ERRCODE='42501';
    END IF;
    mode:=actor#>>'{policy,effective,instructions}';$a$;
  replacement := $r$    IF actor->>'kind'<>'agent' THEN
      RAISE EXCEPTION 'Workspace instructions require a workspace agent context' USING ERRCODE='42501';
    END IF;
    mode:=actor#>>'{policy,effective,instructions}';
    -- Instructions always apply to the whole workspace, so saving one is the
    -- explicit workspace choice. From a chat that learns for its person, the
    -- workspace's Instructions mode also applies, and a pending change joins
    -- the workspace's review rather than a personal one.
    IF actor->>'defaultScope'='personal' AND get_workspace_kind(p_account,p_workspace)<>'personal' THEN
      mode:=(SELECT CASE WHEN 'off' IN (mode,m) OR m IS NULL OR mode IS NULL THEN 'off'
          WHEN 'review_first' IN (mode,m) THEN 'review_first' ELSE 'automatic' END
        FROM (SELECT knowledge_learning_resolve(p_account,p_workspace,NULL,
          coalesce(actor#>>'{policy,contextKey}','defaults'),
          coalesce((actor#>>'{policy,acceptedAt}')::timestamptz,transaction_timestamp()))#>>'{effective,instructions}' AS m) workspace_policy);
      actor:=actor||jsonb_build_object('defaultScope','workspace');
    END IF;$r$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'agent_instruction_apply_0462_unsafe destination anchor drifted';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END $explicit_destination$;
