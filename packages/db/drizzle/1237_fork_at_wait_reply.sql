-- deployment-mode: rolling
-- A message fork can start at an agent reply delivered through
-- wait_for_input's `reply` argument. That reply is recorded as its own
-- agent.message.completed (messageId 'wait_for_input:reply:<attempt>'), but
-- the model wrote it as a tool argument, so no assistant message item in the
-- retained history carries its text. The fork routine only searched assistant
-- message items and refused such a reply as having no retained boundary.
--
-- When the assistant-text search finds nothing for a wait reply, the boundary
-- becomes the result of the turn's latest wait_for_input call whose `reply`
-- argument is exactly that text. Including the call and its result keeps the
-- tool exchange complete. Every other check is unchanged and still fails
-- closed.
--
-- Rolling: only the fork routine body changes; the previous release calls it
-- with the same signature.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $fork_at_wait_reply$
DECLARE
  anchor constant text :=
    $q$  IF boundary_matches <> 1 OR boundary_position IS NULL THEN
    RAISE EXCEPTION 'This message has no unambiguous retained conversation boundary'$q$;
  target constant regprocedure :=
    'fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,uuid)'::regprocedure;
  definition text;
  anchor_count integer;
BEGIN
  definition := pg_get_functiondef(target);
  IF strpos(definition, 'wait_for_input:reply:') > 0 THEN
    RETURN;
  END IF;
  anchor_count := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  IF anchor_count <> 1 THEN
    RAISE EXCEPTION 'fork boundary check of % changed before 1237 (% matches)', target, anchor_count;
  END IF;
  definition := replace(definition, anchor, $q$  IF coalesce(boundary_matches, 0) = 0
    AND selected_event.type = 'agent.message.completed'
    AND starts_with(selected_event.payload ->> 'messageId', 'wait_for_input:reply:')
  THEN
    -- A wait_for_input reply: its text is the wait call's `reply` argument.
    SELECT result_item.position, 1 INTO boundary_position, boundary_matches
    FROM session_history_items call_item
    JOIN session_history_items result_item
      ON result_item.account_id = call_item.account_id
      AND result_item.workspace_id = call_item.workspace_id
      AND result_item.session_id = call_item.session_id
      AND result_item.position > call_item.position
      AND result_item.item ->> 'type' IN ('function_call_result', 'function_call_output')
      AND coalesce(result_item.item ->> 'callId', result_item.item ->> 'call_id')
        = coalesce(call_item.item ->> 'callId', call_item.item ->> 'call_id')
    WHERE call_item.account_id = p_account_id
      AND call_item.workspace_id = p_source_workspace_id
      AND call_item.session_id = p_source_session_id
      AND call_item.turn_id = selected_event.turn_id
      AND call_item.item ->> 'type' = 'function_call'
      AND (call_item.item ->> 'name' = 'wait_for_input'
        OR right(call_item.item ->> 'name', length('__wait_for_input')) = '__wait_for_input')
      AND coalesce(call_item.item ->> 'callId', call_item.item ->> 'call_id') IS NOT NULL
      -- CASE keeps the cast from running on arguments that are not JSON.
      AND CASE WHEN pg_input_is_valid(call_item.item ->> 'arguments', 'jsonb')
        THEN (call_item.item ->> 'arguments')::jsonb ->> 'reply' END
        = selected_event.payload ->> 'text'
    ORDER BY call_item.position DESC, result_item.position
    LIMIT 1;
  END IF;
$q$ || anchor);
  EXECUTE definition;
  IF strpos(pg_get_functiondef(target), 'wait_for_input:reply:') = 0 THEN
    RAISE EXCEPTION 'wait reply fork boundary was not installed for %', target;
  END IF;
END
$fork_at_wait_reply$;
