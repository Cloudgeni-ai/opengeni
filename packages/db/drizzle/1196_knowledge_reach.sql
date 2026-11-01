-- deployment-mode: rolling
-- Where Knowledge works (docs/design/ownership-and-reach.md, rules 3 and 4).
--
-- An organization's Knowledge works in the workspaces it picks, with the same
-- reach as its Skills, model keys, connectors, vaults and machines: every
-- shared workspace (allowed_workspace_ids IS NULL) or the listed ones, and a
-- separate switch for members' Personal workspaces. Existing entries get
-- NULL and true, which is how every organization entry worked so far.
--
-- A person's personal Knowledge works in the workspace where it was added,
-- their Personal workspace, and the workspaces they list in
-- reach_workspace_ids, as their Only me meetings and files do (1186). NULL
-- means every workspace, which is how every personal entry worked so far, so
-- existing entries keep exactly the reach they have. New entries start with
-- an empty list. Workspace Knowledge never leaves its workspace and ignores
-- all three columns.
--
-- The workspace an entry was added in always has it, so it can always be
-- managed from there. The reach decides which workspaces' people and agent
-- turns can list, search, read or cite an entry: every Knowledge read and
-- write already goes through knowledge_scope_visible.
--
-- Changing where an entry works is knowledge_entry_apply's 'reach' operation,
-- for people and services with write access to the entry's scope; agents
-- cannot. It is not a revision of the entry's content, so it keeps the
-- entry's version. knowledge_entry_read's 'reach' operation reads it.
--
-- Adds nullable or constant-default columns, then a default for new rows:
-- all catalog-only. Older binaries never read the columns or call the new
-- operations; a personal entry they save during the rollout gets the narrow
-- default.
SET LOCAL lock_timeout = '5s';

ALTER TABLE knowledge_entries
  ADD COLUMN IF NOT EXISTS allowed_workspace_ids uuid[],
  ADD COLUMN IF NOT EXISTS allow_personal_workspaces boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reach_workspace_ids uuid[];
ALTER TABLE knowledge_entries ALTER COLUMN reach_workspace_ids SET DEFAULT '{}'::uuid[];

DO $knowledge_reach$
DECLARE definition text; anchor text;
BEGIN
  -- Visibility: the existing scope rules first, then where the entry works.
  -- A Personal workspace is looked up only when the cheaper tests leave it
  -- open, as the organization model-key policies do.
  definition := pg_get_functiondef(format(
    '%I.knowledge_scope_visible(%I.knowledge_entries)', current_schema(), current_schema())::regprocedure);
  anchor := $a$
BEGIN
  RETURN coalesce($a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'knowledge_scope_visible opening anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$
DECLARE ws uuid:=nullif(current_setting('opengeni.workspace_id',true),'')::uuid;
BEGIN
  IF NOT coalesce($r$);
  anchor := $a$,false);
END$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'knowledge_scope_visible closing anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$,false) THEN RETURN false; END IF;
  -- Where the entry works (1196). Its own workspace always has it.
  IF e.scope='workspace' OR ws IS NULL OR e.origin_workspace_id=ws THEN RETURN true; END IF;
  IF e.scope='organization' THEN
    IF e.allowed_workspace_ids IS NULL AND e.allow_personal_workspaces THEN RETURN true; END IF;
    IF ws=ANY(e.allowed_workspace_ids) THEN RETURN true; END IF;
  ELSIF e.reach_workspace_ids IS NULL OR ws=ANY(e.reach_workspace_ids) THEN RETURN true;
  END IF;
  IF get_workspace_kind(e.account_id,ws)='personal' THEN
    RETURN e.scope='personal' OR e.allow_personal_workspaces;
  END IF;
  RETURN e.scope='organization' AND e.allowed_workspace_ids IS NULL;
END$r$);
  EXECUTE definition;
END
$knowledge_reach$;

DO $knowledge_reach$
DECLARE definition text; anchor text;
BEGIN
  -- Write: a person or service with write access to the entry's scope
  -- changes where it works. No revision, receipt or version change.
  definition := pg_get_functiondef(format(
    '%I.knowledge_entry_apply(uuid,uuid,jsonb,jsonb)', current_schema())::regprocedure);
  anchor := $a$operation NOT IN ('save','promote_note','approve','approve_edit','reject','restore','archive')$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'knowledge_entry_apply operation anchor drifted';
  END IF;
  definition := replace(definition, anchor,
    $r$operation NOT IN ('save','promote_note','approve','approve_edit','reject','restore','archive','reach')$r$);
  anchor := $a$    RAISE EXCEPTION 'Knowledge review permission required' USING ERRCODE='42501';
  END IF;
$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'knowledge_entry_apply review anchor drifted';
  END IF;
  definition := replace(definition, anchor, anchor || $r$  IF operation='reach' THEN
    DECLARE reach jsonb:=p_request->'reach'; listed uuid[]; prior_reach jsonb;
    BEGIN
      IF actor->>'kind' NOT IN ('human','service') THEN
        RAISE EXCEPTION 'Only people choose where Knowledge works' USING ERRCODE='42501';
      END IF;
      SELECT * INTO e FROM knowledge_entries h WHERE h.account_id=p_account AND h.id=entry_id FOR UPDATE;
      IF NOT FOUND OR NOT knowledge_scope_visible(e) THEN
        RAISE EXCEPTION 'Knowledge unavailable' USING ERRCODE='42501';
      END IF;
      IF e.scope='workspace' THEN
        RAISE EXCEPTION 'Workspace Knowledge works only in its workspace' USING ERRCODE='22023';
      END IF;
      IF NOT coalesce((actor->'writeScopes') ? e.scope,false) THEN
        RAISE EXCEPTION 'Knowledge write permission required for this scope' USING ERRCODE='42501';
      END IF;
      IF jsonb_typeof(reach) IS DISTINCT FROM 'object'
        OR jsonb_typeof(reach->'allowPersonalWorkspaces') IS DISTINCT FROM 'boolean'
        OR (e.scope='personal' AND reach->'allowPersonalWorkspaces'<>'true'::jsonb)
        OR coalesce(jsonb_typeof(reach->'allowedWorkspaceIds'),'missing') NOT IN ('null','array')
        OR (jsonb_typeof(reach->'allowedWorkspaceIds')='array'
          AND (jsonb_array_length(reach->'allowedWorkspaceIds')>500
            OR EXISTS(SELECT 1 FROM jsonb_array_elements(reach->'allowedWorkspaceIds') x
              WHERE jsonb_typeof(x) IS DISTINCT FROM 'string'
                OR x#>>'{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))) THEN
        RAISE EXCEPTION 'Invalid Knowledge reach' USING ERRCODE='22023';
      END IF;
      IF jsonb_typeof(reach->'allowedWorkspaceIds')='array' THEN
        -- The entry's own workspace always has it, so it isn't stored.
        SELECT coalesce(array_agg(DISTINCT x::uuid ORDER BY x::uuid),'{}'::uuid[]) INTO listed
          FROM jsonb_array_elements_text(reach->'allowedWorkspaceIds') x
          WHERE x::uuid<>e.origin_workspace_id;
      END IF;
      prior_reach:=CASE WHEN e.scope='organization' THEN jsonb_build_object(
          'allowedWorkspaceIds',to_jsonb(e.allowed_workspace_ids),'allowPersonalWorkspaces',e.allow_personal_workspaces)
        ELSE jsonb_build_object('allowedWorkspaceIds',to_jsonb(e.reach_workspace_ids),'allowPersonalWorkspaces',true) END;
      IF e.scope='organization' THEN
        UPDATE knowledge_entries h SET allowed_workspace_ids=listed,
          allow_personal_workspaces=(reach->>'allowPersonalWorkspaces')::boolean
          WHERE h.account_id=p_account AND h.id=e.id;
      ELSE
        UPDATE knowledge_entries h SET reach_workspace_ids=listed
          WHERE h.account_id=p_account AND h.id=e.id;
      END IF;
      RETURN jsonb_build_object('entryId',e.id,'scope',e.scope,'originWorkspaceId',e.origin_workspace_id,
        'reach',jsonb_build_object('allowedWorkspaceIds',to_jsonb(listed),
          'allowPersonalWorkspaces',e.scope='personal' OR (reach->>'allowPersonalWorkspaces')::boolean),
        'previous',prior_reach);
    END;
  END IF;
$r$);
  EXECUTE definition;
END
$knowledge_reach$;

DO $knowledge_reach$
DECLARE definition text; anchor text;
BEGIN
  -- Read: where a visible entry works, and whether this person may change it.
  definition := pg_get_functiondef(format(
    '%I.knowledge_entry_read(uuid,uuid,jsonb,jsonb)', current_schema())::regprocedure);
  anchor := $a$  IF operation='policy' AND actor->>'kind'='agent' THEN RETURN actor->'policy'; END IF;
$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'knowledge_entry_read policy anchor drifted';
  END IF;
  definition := replace(definition, anchor, anchor || $r$  IF operation='reach' THEN
    DECLARE e knowledge_entries%ROWTYPE;
    BEGIN
      IF actor->>'kind' NOT IN ('human','service') THEN
        RAISE EXCEPTION 'Only people choose where Knowledge works' USING ERRCODE='42501';
      END IF;
      SELECT * INTO e FROM knowledge_entries h WHERE h.account_id=p_account
        AND h.id=(p_request->>'entryId')::uuid;
      IF NOT FOUND OR NOT knowledge_scope_visible(e) THEN RETURN NULL; END IF;
      RETURN jsonb_build_object('entryId',e.id,'scope',e.scope,'originWorkspaceId',e.origin_workspace_id,
        'reach',CASE e.scope
          WHEN 'organization' THEN jsonb_build_object('allowedWorkspaceIds',to_jsonb(e.allowed_workspace_ids),
            'allowPersonalWorkspaces',e.allow_personal_workspaces)
          WHEN 'personal' THEN jsonb_build_object('allowedWorkspaceIds',to_jsonb(e.reach_workspace_ids),
            'allowPersonalWorkspaces',true) END,
        'canChange',e.scope<>'workspace' AND coalesce((actor->'writeScopes') ? e.scope,false));
    END;
  END IF;
$r$);
  EXECUTE definition;
END
$knowledge_reach$;
