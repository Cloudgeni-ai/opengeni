-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: the seed copies at most each member's latest Personal defaults and the few chat or task overrides from their own Personal workspace, a handful of agent_learning_revisions rows per organization member.
-- A Personal workspace learns like a shared workspace. Its only difference is
-- that nobody but its owner can be in it, so its Workspace layer is as private
-- as the owner's Personal layer. Until now every chat or task there with a
-- verified person learned to that person's Personal layer, work without a
-- person had all learning frozen Off (0868), and a personal-scope chat there
-- skipped the workspace's own mode when it saved to the workspace. Now:
--   1. a chat or task in a Personal workspace learns to the destination the
--      shared rules give it: Only me and user-memory chats (and personal
--      connector tasks) to the person, everything else to the workspace;
--   2. work without a person learns to the workspace under its modes, as in a
--      shared workspace;
--   3. a personal-scope chat saving to the workspace is governed by the
--      stricter of its own mode and the workspace's, as in a shared workspace;
--   4. as in a shared workspace, only work that learns for its person reads
--      that person's Personal Knowledge and Only me files. The existing
--      personal entries, Skills, instructions and Only me files made there
--      are unchanged: the owner and their Only me chats keep them;
--   5. the owner's saved Personal defaults, and their per-chat and per-task
--      overrides from that workspace, are copied to the Personal workspace's
--      own layer when it has none, so its chats keep the modes the owner
--      chose. Their Personal layer is unchanged and still governs their Only
--      me chats everywhere.
-- Organization admins, other members and other workspaces still cannot reach
-- a Personal workspace, so its Workspace layer stays the owner's alone.
-- Previous binaries: an accepted snapshot never changes, and turns already
-- running keep their accepted Personal destination (the shared-chat retention
-- rule in knowledge_resolve_actor). A previous API still asks for a Personal
-- override when it creates a Personal-workspace chat with chat learning
-- choices; until it is replaced that one request is refused as before for a
-- mismatched owner layer, and the chat can be created again.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $personal_workspace_learning_scope$
DECLARE definition text; anchor text;
BEGIN
  -- 1. Settings for a chat or task use the same owner layer the work uses.
  definition := pg_get_functiondef(format(
    '%I.knowledge_learning_context_visible(uuid,uuid,text,text,text)', current_schema())::regprocedure);
  anchor := $a$    IF get_workspace_kind(p_account,p_workspace)='personal' THEN RETURN p_scope='personal' AND p_subject IS NOT NULL; END IF;
$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 3 THEN
    RAISE EXCEPTION 'knowledge_learning_context_visible personal workspace anchor drifted';
  END IF;
  definition := replace(definition, anchor, '');
  EXECUTE definition;

  -- 1 and 2. The accepted turn's destination.
  definition := pg_get_functiondef(format(
    '%I.knowledge_learning_for_turn(uuid,uuid,uuid)', current_schema())::regprocedure);
  anchor := $a$  destination:=CASE WHEN s.visibility='user_private' OR s.memory_scope='user'
    OR (subject IS NOT NULL AND get_workspace_kind(p_account,p_workspace)='personal') THEN 'personal' ELSE 'workspace' END;
$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'knowledge_learning_for_turn destination anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$  destination:=CASE WHEN s.visibility='user_private' OR s.memory_scope='user' THEN 'personal' ELSE 'workspace' END;
$r$);
  anchor := $a$  -- Human-less work in a personal workspace reads but never saves (0868).
  IF destination='workspace' AND get_workspace_kind(p_account,p_workspace)='personal' THEN
    result:=jsonb_set(result,'{effective}','{"knowledge":"off","instructions":"off","skills":"off"}'::jsonb);
  END IF;
  result:=result||jsonb_build_object('defaultScope',destination,'subjectId',subject,'acceptedAt',accepted_at);
$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'knowledge_learning_for_turn snapshot anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$  result:=result||jsonb_build_object('defaultScope',destination,'subjectId',subject,'acceptedAt',accepted_at);
$r$);
  EXECUTE definition;

  -- 1. The live agent actor's destination.
  definition := pg_get_functiondef(format(
    '%I.knowledge_resolve_actor(uuid,uuid,jsonb)', current_schema())::regprocedure);
  anchor := $a$  destination:=CASE WHEN s.visibility='user_private' OR s.memory_scope='user'
    OR (subject IS NOT NULL AND get_workspace_kind(p_account,p_workspace)='personal')
    THEN 'personal' ELSE 'workspace' END;
$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'knowledge_resolve_actor destination anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$  destination:=CASE WHEN s.visibility='user_private' OR s.memory_scope='user'
    THEN 'personal' ELSE 'workspace' END;
$r$);
  EXECUTE definition;

  -- 3. A personal-scope chat saving to the workspace meets the workspace's
  --    mode in a Personal workspace too: Knowledge, instructions, Skills.
  definition := pg_get_functiondef(format(
    '%I.knowledge_entry_apply(uuid,uuid,jsonb,jsonb)', current_schema())::regprocedure);
  anchor := $a$    IF actor->>'kind'='agent' AND actor->>'defaultScope'='personal' AND scope_value='workspace'
      AND get_workspace_kind(p_account,p_workspace)<>'personal' THEN
$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'knowledge_entry_apply personal workspace anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$    IF actor->>'kind'='agent' AND actor->>'defaultScope'='personal' AND scope_value='workspace' THEN
$r$);
  EXECUTE definition;

  definition := pg_get_functiondef(format(
    '%I.agent_instruction_apply_0462_unsafe(uuid,uuid,jsonb,jsonb)', current_schema())::regprocedure);
  anchor := $a$    IF actor->>'defaultScope'='personal' AND get_workspace_kind(p_account,p_workspace)<>'personal' THEN
$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'agent_instruction_apply_0462_unsafe personal workspace anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$    IF actor->>'defaultScope'='personal' THEN
$r$);
  EXECUTE definition;

  definition := pg_get_functiondef(format(
    '%I.skill_apply_lifecycle(uuid,uuid,jsonb,jsonb)', current_schema())::regprocedure);
  anchor := $a$  IF p_actor->>'kind'='agent' AND learning_actor->>'defaultScope'='personal' AND scope='workspace'
    AND get_workspace_kind(p_account_id,p_workspace_id)<>'personal' THEN
$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'skill_apply_lifecycle personal workspace anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$  IF p_actor->>'kind'='agent' AND learning_actor->>'defaultScope'='personal' AND scope='workspace' THEN
$r$);
  EXECUTE definition;
END $personal_workspace_learning_scope$;

-- 5. Keep each Personal workspace's chats on the modes its owner chose. Only a
--    layer with no row of its own for that context is seeded, so an owner's
--    own Workspace choice is never overwritten.
DO $personal_workspace_learning_seed$
DECLARE member record; previous_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle',true);
  previous_account text := current_setting('opengeni.account_id',true);
BEGIN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle','organization_membership_lifecycle',true);
  FOR member IN
    SELECT m.account_id,m.subject_id,m.personal_workspace_id FROM organization_memberships m
    WHERE m.personal_workspace_id IS NOT NULL
    ORDER BY m.account_id,m.personal_workspace_id
  LOOP
    PERFORM set_config('opengeni.account_id',member.account_id::text,true);
    INSERT INTO agent_learning_revisions(account_id,origin_workspace_id,owner_key,subject_id,context_key,
      version,settings,operation_id,request_hash,actor_subject_id,created_at)
    SELECT member.account_id,member.personal_workspace_id,'workspace:'||member.personal_workspace_id,NULL,
      source.context_key,1,source.settings,gen_random_uuid(),
      'migration:1095:personal-workspace-learning:'||source.id,'service:knowledge-compatibility',source.created_at
    FROM (SELECT DISTINCT ON (r.context_key) r.* FROM agent_learning_revisions r
      WHERE r.account_id=member.account_id AND r.owner_key='personal:'||member.subject_id
        AND (r.context_key='defaults' OR r.origin_workspace_id=member.personal_workspace_id)
      ORDER BY r.context_key,r.version DESC) source
    WHERE NOT EXISTS(SELECT 1 FROM agent_learning_revisions existing
      WHERE existing.account_id=member.account_id
        AND existing.owner_key='workspace:'||member.personal_workspace_id
        AND existing.context_key=source.context_key);
  END LOOP;
  PERFORM set_config('opengeni.account_id',coalesce(previous_account,''),true);
  PERFORM set_config('opengeni.organization_tenancy_lifecycle',coalesce(previous_lifecycle,''),true);
END $personal_workspace_learning_seed$;
