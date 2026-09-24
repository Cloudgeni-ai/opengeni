-- deployment-mode: rolling
-- A message fork copies the retained model-facing prefix through its selected
-- boundary. After real compaction, old rows are inactive and the replacement
-- (including the summary) is active: copy only that active prefix. Never
-- reinterpret a superseded message as a valid boundary. Opaque compaction
-- items need the exact earlier durable compaction receipt to enter a fork.
DO $migration$
DECLARE
  target regprocedure := 'fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,uuid)'::regprocedure;
  definition text;
  updated text;
  change record;
BEGIN
  definition := pg_get_functiondef(target);
  updated := definition;
  FOR change IN SELECT * FROM (VALUES
    (E'AND history.turn_id = selected_turn_id\n        AND history.item ->> ''role'' = ''user''',
     E'AND history.turn_id = selected_turn_id\n        AND history.active\n        AND history.item ->> ''role'' = ''user'''),
    (E'AND history.turn_id = selected_event.turn_id\n        AND history.item ->> ''role'' = ''assistant''',
     E'AND history.turn_id = selected_event.turn_id\n        AND history.active\n        AND history.item ->> ''role'' = ''assistant'''),
    (E'AND history.session_id = p_source_session_id\n      AND (NOT history.active OR history.position <> trunc(history.position)',
     E'AND history.session_id = p_source_session_id\n      AND history.position <= boundary_position\n      AND history.active\n      AND (history.position <> trunc(history.position)'),
    ('OR history.item ->> ''type'' = ''compaction''',
     $replacement$OR (history.item ->> 'type' = 'compaction' AND NOT EXISTS (
      SELECT 1 FROM session_events compaction_event
      WHERE compaction_event.account_id = p_account_id
        AND compaction_event.workspace_id = p_source_workspace_id
        AND compaction_event.session_id = p_source_session_id
        AND compaction_event.type = 'session.context.compacted'
        AND compaction_event.payload ->> 'summaryPosition' = history.position::text
        AND compaction_event.sequence < selected_event.sequence
    ))$replacement$),
    (E'AND history.session_id = p_source_session_id AND history.position <= boundary_position',
     E'AND history.session_id = p_source_session_id AND history.active\n        AND history.position <= boundary_position'),
    (E'AND source_item.session_id = p_source_session_id AND source_item.position <= boundary_position',
     E'AND source_item.session_id = p_source_session_id AND source_item.active\n      AND source_item.position <= boundary_position')
  ) AS rewrites(anchor, replacement) LOOP
    IF (length(updated) - length(replace(updated, change.anchor, ''))) / length(change.anchor) <> 1 THEN
      RAISE EXCEPTION 'message fork prefix rewrite did not match exactly once at %', left(change.anchor, 96);
    END IF;
    updated := replace(updated, change.anchor, change.replacement);
  END LOOP;
  EXECUTE updated;
END
$migration$;