-- deployment-mode: rolling
-- An approval whose tool's MCP server asks the person a question mid-call
-- (0981) reads as that question wherever approvals reach the person. Its
-- inbox item is titled with the server's question and records which server
-- asks and what kind of question it is: a plain confirmation the inbox
-- answers in one tap, a page to open first, or fields to fill in. Its phone
-- push says what the server asks, and a page or fields carry
-- serverQuestionKind so the push offers no lock-screen Approve.
-- The new column is nullable without default (catalog-only); the previous
-- release reads list_inbox_items_v3, which keeps working.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE opengeni_private.inbox_items
  ADD COLUMN IF NOT EXISTS server_question jsonb;
COMMENT ON COLUMN opengeni_private.inbox_items.server_question IS
  'For an approval its MCP server asks a question about: {server, kind, url?}. kind is form when any question has fields to fill in, else url when one asks to open a page (url is that page), else confirm. Null otherwise.';

DO $inbox$
DECLARE
  definition text;
  anchor text := $old$          PERFORM opengeni_private.open_inbox_item_v1(
            NEW.account_id, NEW.workspace_id, NEW.session_id, v_recipient, 'approval',
            v_approval ->> 'id',
            coalesce(v_approval #>> '{display,toolName}', v_approval ->> 'name', 'A tool call'),
            coalesce(v_approval #>> '{display,title}', v_approval #>> '{display,serverName}', ''),
            'normal');$old$;
  replacement text := $new$          IF jsonb_typeof(v_approval #> '{elicitation,requests}') = 'array' THEN
            -- The tool's MCP server asks the person mid-call: the item is its
            -- question, under the call it belongs to.
            PERFORM opengeni_private.open_inbox_item_v1(
              NEW.account_id, NEW.workspace_id, NEW.session_id, v_recipient, 'approval',
              v_approval ->> 'id',
              coalesce(nullif(btrim(v_approval #>> '{elicitation,requests,0,message}'), ''),
                v_approval #>> '{display,toolName}', v_approval ->> 'name', 'A tool call'),
              coalesce(v_approval #>> '{display,title}', v_approval #>> '{display,toolName}',
                v_approval ->> 'name', ''),
              'normal');
          ELSE
            PERFORM opengeni_private.open_inbox_item_v1(
              NEW.account_id, NEW.workspace_id, NEW.session_id, v_recipient, 'approval',
              v_approval ->> 'id',
              coalesce(v_approval #>> '{display,toolName}', v_approval ->> 'name', 'A tool call'),
              coalesce(v_approval #>> '{display,title}', v_approval #>> '{display,serverName}', ''),
              'normal');
          END IF;
          DECLARE
            v_question_requests jsonb := CASE
              WHEN jsonb_typeof(v_approval #> '{elicitation,requests}') = 'array'
              THEN v_approval #> '{elicitation,requests}' END;
            v_question_kind text;
            v_question_url text;
          BEGIN
            IF v_question_requests IS NOT NULL THEN
              SELECT request.value ->> 'url' INTO v_question_url
              FROM jsonb_array_elements(v_question_requests) WITH ORDINALITY request(value, position)
              WHERE request.value ->> 'mode' = 'url'
              ORDER BY request.position
              LIMIT 1;
              v_question_kind := CASE
                WHEN EXISTS (
                  SELECT 1 FROM jsonb_array_elements(v_question_requests) request
                  WHERE jsonb_typeof(request.value #> '{requestedSchema,properties}') = 'object'
                    AND request.value #> '{requestedSchema,properties}' <> '{}'::jsonb)
                  THEN 'form'
                WHEN v_question_url IS NOT NULL THEN 'url'
                ELSE 'confirm' END;
            END IF;
            UPDATE opengeni_private.inbox_items item
            SET server_question = CASE WHEN v_question_kind IS NOT NULL THEN
              jsonb_build_object(
                'server', left(coalesce(v_approval #>> '{elicitation,server}', 'The server'), 256),
                'kind', v_question_kind)
                || CASE WHEN v_question_kind = 'url'
                  THEN jsonb_build_object('url', left(v_question_url, 2048)) ELSE '{}'::jsonb END
              END
            WHERE item.session_id = NEW.session_id AND item.kind = 'approval'
              AND item.source_key = v_approval ->> 'id'
              AND item.recipient_subject_id = v_recipient;
          END;$new$;
BEGIN
  definition := pg_get_functiondef('opengeni_private.project_inbox_for_session_event_v1()'::regprocedure);
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'inbox approval projection anchor drifted';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END $inbox$;

DO $push$
DECLARE
  definition text;
  body_anchor text := $old$      WHEN 'session.requiresAction' THEN 'Approve ' || coalesce(
        NEW.payload #>> '{approvals,0,display,toolName}', NEW.payload #>> '{approvals,0,name}',
        'a tool call') || '?'$old$;
  body_replacement text := $new$      -- An MCP server's question about the call reads as that question.
      WHEN 'session.requiresAction' THEN coalesce(
        coalesce(NEW.payload #>> '{approvals,0,elicitation,server}', 'The server') || ' asks: '
          || nullif(btrim(NEW.payload #>> '{approvals,0,elicitation,requests,0,message}'), ''),
        'Approve ' || coalesce(
        NEW.payload #>> '{approvals,0,display,toolName}', NEW.payload #>> '{approvals,0,name}',
        'a tool call') || '?')$new$;
  extra_anchor text := $old$        NEW.session_id, v_rule, NEW.id::text, NULL, left(v_body, 240), NEW.type,
        jsonb_build_object('sequence', NEW.sequence));$old$;
  extra_replacement text := $new$        NEW.session_id, v_rule, NEW.id::text, NULL, left(v_body, 240), NEW.type,
        jsonb_build_object('sequence', NEW.sequence)
          -- A server question with fields is answered in its form, and one
          -- that asks to open a page in the app, never on the lock screen.
          || CASE WHEN NEW.type = 'session.requiresAction'
              AND jsonb_typeof(NEW.payload -> 'approvals') = 'array' THEN coalesce((
                SELECT jsonb_build_object('serverQuestionKind',
                  CASE WHEN bool_or(shape.fields) THEN 'form' ELSE 'url' END)
                FROM jsonb_array_elements(NEW.payload -> 'approvals') approval
                CROSS JOIN LATERAL jsonb_array_elements(CASE
                  WHEN jsonb_typeof(approval.value #> '{elicitation,requests}') = 'array'
                  THEN approval.value #> '{elicitation,requests}' ELSE '[]'::jsonb END) request
                CROSS JOIN LATERAL (SELECT coalesce(
                  jsonb_typeof(request.value #> '{requestedSchema,properties}') = 'object'
                    AND request.value #> '{requestedSchema,properties}' <> '{}'::jsonb,
                  false) AS fields) shape
                WHERE shape.fields OR request.value ->> 'mode' = 'url'
                HAVING count(*) > 0), '{}'::jsonb)
            ELSE '{}'::jsonb END);$new$;
BEGIN
  definition := pg_get_functiondef('opengeni_private.enqueue_native_push_for_session_event_v1()'::regprocedure);
  IF cardinality(string_to_array(definition, body_anchor)) <> 2
    OR cardinality(string_to_array(definition, extra_anchor)) <> 2 THEN
    RAISE EXCEPTION 'native push approval anchor drifted';
  END IF;
  EXECUTE replace(replace(definition, body_anchor, body_replacement), extra_anchor, extra_replacement);
END $push$;

-- As v3, with each approval item's server question.
CREATE FUNCTION opengeni_private.list_inbox_items_v4(p_account_id uuid, p_subject_id text)
RETURNS TABLE (
  id uuid, workspace_id uuid, session_id uuid, kind text,
  source_key text, title text, subtitle text, body text, facts jsonb, link jsonb,
  event_sequence integer, choices jsonb, server_question jsonb, urgency text, status text,
  unread boolean, snoozed_until timestamptz, created_at timestamptz, updated_at timestamptz,
  resolved_at timestamptz, sender_subject_id text, sender_label text
)
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $list$
  SELECT item.id, item.workspace_id, item.session_id, item.kind,
    item.source_key, item.title, item.subtitle, item.body, item.facts, item.link,
    item.event_sequence, item.choices, item.server_question, item.urgency, item.status,
    item.seen_version < item.content_version, item.snoozed_until, item.created_at,
    item.updated_at, item.resolved_at, item.sender_subject_id, item.sender_label
  FROM opengeni_private.inbox_items item
  WHERE item.account_id = p_account_id
    AND item.recipient_subject_id = p_subject_id
    AND item.status = 'open'
  ORDER BY item.updated_at DESC
  LIMIT 500
$list$;

DO $inbox_server_questions$
DECLARE
  target_schema text := current_schema();
BEGIN
  REVOKE ALL ON FUNCTION opengeni_private.list_inbox_items_v4(uuid,text) FROM PUBLIC;
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.list_inbox_items_v4(uuid,text) SET search_path = pg_catalog, %I, pg_temp',
    target_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.list_inbox_items_v4(uuid,text) TO opengeni_app;
  END IF;
END $inbox_server_questions$;
