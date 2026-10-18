-- deployment-mode: rolling
-- Complete the explicit learning destination from 0819, refusing only where
-- there is an authority reason:
-- * A shared chat's agent may change the initiating person's own personal
--   Skill: by its id, or by explicitly creating a Skill with scope 'user'.
--   The person's own Skills mode applies too (the stricter of the chat's and
--   theirs). Work without a verified initiating person (for example, an
--   unattended scheduled run) has no person to save for and is still refused,
--   as is any other person's Skill and a removal (no restorable history).
-- * A personal chat's agent may save workspace-scoped Knowledge: correcting an
--   existing workspace entry by its id, or an explicit workspace scope. The
--   workspace's Knowledge mode applies too, and a pending change joins the
--   workspace's review. Evidence and link validation is unchanged, so shared
--   Knowledge still cannot point at private evidence.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $explicit_destination_symmetry$
DECLARE definition text; anchor text; replacement text;
BEGIN
  SELECT pg_get_functiondef(format('%I.skill_apply_lifecycle(uuid,uuid,jsonb,jsonb)', current_schema())::regprocedure)
    INTO STRICT definition;

  -- 1. An explicit destination, in either direction.
  anchor := $a$    IF p_request ? 'scope' AND p_request->>'scope' IS DISTINCT FROM scope THEN
      IF NOT (scope='user' AND p_request->>'scope'='workspace') THEN
        RAISE EXCEPTION 'Skill scope is not available to this chat' USING ERRCODE='42501'; END IF;
      scope:='workspace';
    END IF;$a$;
  replacement := $r$    IF p_request ? 'scope' AND p_request->>'scope' IS DISTINCT FROM scope THEN
      IF NOT ((scope='user' AND p_request->>'scope'='workspace')
        OR (scope='workspace' AND p_request->>'scope'='user' AND learning_actor->>'subjectId' IS NOT NULL)) THEN
        RAISE EXCEPTION 'Skill scope is not available to this chat' USING ERRCODE='42501'; END IF;
      scope:=p_request->>'scope';
    END IF;$r$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'skill_apply_lifecycle explicit scope anchor drifted';
  END IF;
  definition := replace(definition, anchor, replacement);

  -- 2. Changing (not removing) an existing Skill by its id chooses its scope.
  anchor := $a$      IF NOT (head.scope='workspace' AND scope='user' AND operation<>'remove') THEN
        RAISE EXCEPTION 'Skill outside accepted learning scope' USING ERRCODE='42501'; END IF;
      scope:='workspace';$a$;
  replacement := $r$      IF operation='remove' OR NOT ((head.scope='workspace' AND scope='user')
        OR (head.scope='user' AND scope='workspace' AND learning_actor->>'subjectId' IS NOT NULL)) THEN
        RAISE EXCEPTION 'Skill outside accepted learning scope' USING ERRCODE='42501'; END IF;
      -- The head check below still refuses another person's personal Skill.
      scope:=head.scope;$r$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'skill_apply_lifecycle head scope anchor drifted';
  END IF;
  definition := replace(definition, anchor, replacement);

  -- 3. The person's own Skills mode bounds a shared chat's personal change.
  anchor := $a$    IF mode='off' THEN RAISE EXCEPTION 'Learning is Off; durable Skill changes are refused' USING ERRCODE='42501'; END IF;
    IF mode='review_first' THEN mode:='suggest'; END IF;
  END IF;$a$;
  replacement := $r$    IF mode='off' THEN RAISE EXCEPTION 'Learning is Off; durable Skill changes are refused' USING ERRCODE='42501'; END IF;
    IF mode='review_first' THEN mode:='suggest'; END IF;
  END IF;
  IF p_actor->>'kind'='agent' AND learning_actor->>'defaultScope'='workspace' AND scope='user' THEN
    mode:=CASE WHEN mode='suggest' THEN 'review_first' ELSE mode END;
    mode:=(SELECT CASE WHEN 'off' IN (mode,m) OR m IS NULL THEN 'off'
        WHEN 'review_first' IN (mode,m) THEN 'review_first' ELSE 'automatic' END
      FROM (SELECT knowledge_learning_resolve(p_account_id,p_workspace_id,learning_actor->>'subjectId',
        coalesce(learning_policy->>'contextKey','defaults'),
        coalesce((learning_policy->>'acceptedAt')::timestamptz,transaction_timestamp()))#>>'{effective,skills}' AS m) personal_policy);
    IF mode='off' THEN RAISE EXCEPTION 'Learning is Off; durable Skill changes are refused' USING ERRCODE='42501'; END IF;
    IF mode='review_first' THEN mode:='suggest'; END IF;
  END IF;$r$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'skill_apply_lifecycle personal mode anchor drifted';
  END IF;
  definition := replace(definition, anchor, replacement);
  EXECUTE definition;

  SELECT pg_get_functiondef(format('%I.knowledge_entry_apply(uuid,uuid,jsonb,jsonb)', current_schema())::regprocedure)
    INTO STRICT definition;
  anchor := $a$    IF scope_value IS DISTINCT FROM actor->>'defaultScope' OR (actor->>'retentionScope'='session' AND e.id IS NOT NULL
      AND (e.legacy_scope_type IS DISTINCT FROM 'session' OR e.legacy_scope_session_id IS DISTINCT FROM (actor->>'sessionId')::uuid)) THEN
      RAISE EXCEPTION 'Agent Knowledge stays in its accepted scope' USING ERRCODE='42501';
    END IF;
    mode:=actor#>>'{policy,effective,knowledge}';$a$;
  replacement := $r$    IF (scope_value IS DISTINCT FROM actor->>'defaultScope'
        AND NOT (actor->>'kind'='agent' AND actor->>'defaultScope'='personal' AND scope_value='workspace'))
      OR (actor->>'retentionScope'='session' AND e.id IS NOT NULL
      AND (e.legacy_scope_type IS DISTINCT FROM 'session' OR e.legacy_scope_session_id IS DISTINCT FROM (actor->>'sessionId')::uuid)) THEN
      RAISE EXCEPTION 'Agent Knowledge stays in its accepted scope' USING ERRCODE='42501';
    END IF;
    mode:=actor#>>'{policy,effective,knowledge}';
    IF actor->>'kind'='agent' AND actor->>'defaultScope'='personal' AND scope_value='workspace'
      AND get_workspace_kind(p_account,p_workspace)<>'personal' THEN
      mode:=(SELECT CASE WHEN 'off' IN (mode,m) OR m IS NULL OR mode IS NULL THEN 'off'
          WHEN 'review_first' IN (mode,m) THEN 'review_first' ELSE 'automatic' END
        FROM (SELECT knowledge_learning_resolve(p_account,p_workspace,NULL,
          coalesce(actor#>>'{policy,contextKey}','defaults'),
          coalesce((actor#>>'{policy,acceptedAt}')::timestamptz,transaction_timestamp()))#>>'{effective,knowledge}' AS m) workspace_policy);
    END IF;$r$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'knowledge_entry_apply destination anchor drifted';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END $explicit_destination_symmetry$;
