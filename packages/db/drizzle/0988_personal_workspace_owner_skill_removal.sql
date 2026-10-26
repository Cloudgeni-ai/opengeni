-- deployment-mode: rolling
-- The verified owner's chat in their own Personal workspace may remove that
-- workspace's Skills. Every chat there learns for its person, so 0819/0824
-- refused any removal of a workspace-scoped Skill from it, leaving the
-- Skills page as the owner's only way to remove one. A Personal workspace has
-- no other member: its workspace Skills are the owner's own, as their
-- personal Skills are, and the owner may already save and edit them from the
-- same chat. Removal stays permanent: the chat's own Skills mode still
-- applies (Automatic removes, Review first leaves an explicit deletion
-- proposal for the owner, Off refuses). Shared workspaces keep the 0824 rule:
-- a private chat removes only its person's own Skills, and nobody else's
-- personal Skill is reachable.
-- A removal never chooses a destination, so an explicit scope on it is
-- refused: otherwise a request naming the Skill's own scope would skip the
-- cross-scope check below. The agent tool sends no scope on a removal, so
-- previous binaries are unaffected.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $personal_workspace_owner_skill_removal$
DECLARE definition text; anchor text; replacement text;
BEGIN
  SELECT pg_get_functiondef(format('%I.skill_apply_lifecycle(uuid,uuid,jsonb,jsonb)', current_schema())::regprocedure)
    INTO STRICT definition;

  -- 1. A removal names no destination.
  anchor := $a$    IF p_request ? 'scope' AND p_request->>'scope' IS DISTINCT FROM scope THEN
      IF NOT ((scope='user' AND p_request->>'scope'='workspace')$a$;
  replacement := $r$    IF operation='remove' AND p_request ? 'scope' THEN
      RAISE EXCEPTION 'Skill scope is not available to this chat' USING ERRCODE='42501'; END IF;
    IF p_request ? 'scope' AND p_request->>'scope' IS DISTINCT FROM scope THEN
      IF NOT ((scope='user' AND p_request->>'scope'='workspace')$r$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'skill_apply_lifecycle removal scope anchor drifted';
  END IF;
  definition := replace(definition, anchor, replacement);

  -- 2. The owner's own Personal workspace Skills.
  anchor := $a$      IF operation='remove' OR NOT ((head.scope='workspace' AND scope='user')
        OR (head.scope='user' AND scope='workspace' AND learning_actor->>'subjectId' IS NOT NULL)) THEN
        RAISE EXCEPTION 'Skill outside accepted learning scope' USING ERRCODE='42501'; END IF;$a$;
  replacement := $r$      IF operation='remove' AND head.scope='workspace' AND scope='user'
        AND head.scope_workspace_id=p_workspace_id AND learning_actor->>'subjectId' IS NOT NULL
        AND get_workspace_kind(p_account_id,p_workspace_id)='personal' THEN
        -- Only the verified owner's own Personal workspace: its workspace
        -- Skills have no other audience.
        DECLARE previous_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle',true);
          personal_owner boolean;
        BEGIN
          PERFORM set_config('opengeni.organization_tenancy_lifecycle','organization_membership_lifecycle',true);
          personal_owner:=EXISTS(SELECT 1 FROM organization_memberships m WHERE m.account_id=p_account_id
            AND m.personal_workspace_id=p_workspace_id AND m.status='active'
            AND m.subject_id=learning_actor->>'subjectId');
          PERFORM set_config('opengeni.organization_tenancy_lifecycle',coalesce(previous_lifecycle,''),true);
          IF NOT personal_owner THEN
            RAISE EXCEPTION 'Skill outside accepted learning scope' USING ERRCODE='42501'; END IF;
        END;
      ELSIF operation='remove' OR NOT ((head.scope='workspace' AND scope='user')
        OR (head.scope='user' AND scope='workspace' AND learning_actor->>'subjectId' IS NOT NULL)) THEN
        RAISE EXCEPTION 'Skill outside accepted learning scope' USING ERRCODE='42501'; END IF;$r$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'skill_apply_lifecycle personal workspace removal anchor drifted';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END $personal_workspace_owner_skill_removal$;
