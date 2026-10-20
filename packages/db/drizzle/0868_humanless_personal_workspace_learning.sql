-- deployment-mode: rolling
-- A turn with no initiating human (a published-Site guest, or any other
-- service-initiated work) in a personal workspace failed right after
-- turn.started. The learning snapshot and the agent's Knowledge actor derived
-- a Personal destination from the workspace kind alone, then refused it with
-- 42501 because no verified owner existed to hold Personal authority.
--
-- Personal is now derived from the workspace kind only when the turn has a
-- verified initiating human. Human-less work there uses the Workspace
-- destination with no subject, exactly as it already does in a shared
-- workspace, so it can never read or write anyone's Personal layer. A
-- private session or a session that explicitly chose user memory still
-- requires its verified owner and still refuses without one.
--
-- A personal workspace's Workspace layer is not shown in its settings, so its
-- owner could not see or control what such work saved there. Human-less work
-- in a personal workspace therefore freezes every learning mode as Off: it can
-- read what the Workspace layer allows, as before, but it saves no Knowledge,
-- Skills or instructions. Work in a shared workspace is unchanged.
--
-- Only these two function bodies change; owners, grants and settings stay.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $repair$
DECLARE definition text; routine text;
  anchor text := $old$OR get_workspace_kind(p_account,p_workspace)='personal'$old$;
  replacement text := $new$OR (subject IS NOT NULL AND get_workspace_kind(p_account,p_workspace)='personal')$new$;
  snapshot_anchor text := $old$result:=result||jsonb_build_object('defaultScope',destination,'subjectId',subject,'acceptedAt',accepted_at);$old$;
  snapshot_replacement text := $new$-- Human-less work in a personal workspace reads but never saves (0868).
  IF destination='workspace' AND get_workspace_kind(p_account,p_workspace)='personal' THEN
    result:=jsonb_set(result,'{effective}','{"knowledge":"off","instructions":"off","skills":"off"}'::jsonb);
  END IF;
  result:=result||jsonb_build_object('defaultScope',destination,'subjectId',subject,'acceptedAt',accepted_at);$new$;
BEGIN
  FOREACH routine IN ARRAY ARRAY['knowledge_learning_for_turn(uuid,uuid,uuid)',
    'knowledge_resolve_actor(uuid,uuid,jsonb)'] LOOP
    SELECT pg_get_functiondef(format('%I.%s', current_schema(), routine)::regprocedure)
      INTO STRICT definition;
    IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
      RAISE EXCEPTION '% personal destination anchor drifted', routine;
    END IF;
    definition := replace(definition, anchor, replacement);
    IF routine LIKE 'knowledge_learning_for_turn%' THEN
      IF cardinality(string_to_array(definition, snapshot_anchor)) <> 2 THEN
        RAISE EXCEPTION '% learning snapshot anchor drifted', routine;
      END IF;
      definition := replace(definition, snapshot_anchor, snapshot_replacement);
    END IF;
    EXECUTE definition;
  END LOOP;
END $repair$;
