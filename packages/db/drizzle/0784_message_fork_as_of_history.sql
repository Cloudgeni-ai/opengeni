-- deployment-mode: rolling
-- A message fork copies the history the model had when that message was
-- written, including a message from before a later compaction or clear.
--
-- Every context reset deactivates all rows and appends its new segment after
-- them (compaction: retained messages, summary, trailing items; clear: one
-- marker), so position order is model order. The history live at a boundary
-- is therefore the latest segment that starts at or before it, through the
-- boundary. A later reset only deactivates those rows, which stay retained,
-- so they are copied back (as active rows) instead of refusing the fork.
--
-- The segment start comes from the reset's own receipt: a clear's marker
-- position, or a compaction's replacementFromPosition. Receipts written before
-- that field existed identify the replacement rows by their insert
-- transaction: they share the summary row's created_at, and every earlier row
-- predates that transaction. Anything the retained rows cannot prove fails
-- closed: an older fractional-summary compaction, a row still active before the
-- segment, a superseded row with no later reset, an opaque compaction item
-- without a receipt, or an unknown fractional row.
--
-- The preflight verifies every catalog-source anchor, the migration block only
-- patches and executes the routine source, and the postflight confirms the
-- installed definition. All three share the migration's implicit transaction.
DO $preflight$
DECLARE
  definition text;
  anchor text;
BEGIN
  definition := pg_get_functiondef('fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,uuid)'::regprocedure);
  FOR anchor IN SELECT * FROM (VALUES
    (E'  boundary_matches integer;\n'),
    (E'AND history.turn_id = selected_turn_id\n        AND history.active\n        AND history.item ->> ''role'' = ''user'''),
    (E'AND history.turn_id = selected_event.turn_id\n        AND history.active\n        AND history.item ->> ''role'' = ''assistant'''),
    (E'  -- Compaction can replace an earlier prefix with a summary containing later\n'),
    (E'    RAISE EXCEPTION ''Forking at a message is unavailable after conversation compaction'' USING ERRCODE = ''22023'';\n  END IF;\n'),
    (E'AND history.session_id = p_source_session_id AND history.active\n        AND history.position <= boundary_position'),
    (E'      source_item.item_codec_version, source_item.active,\n'),
    (E'AND source_item.session_id = p_source_session_id AND source_item.active\n      AND source_item.position <= boundary_position'),
    (E'  -- boundary from timestamps or manufacture model input from audit events.\n')
  ) AS anchors(value) LOOP
    IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
      RAISE EXCEPTION 'message fork as-of history rewrite did not match exactly once at %', left(anchor, 96);
    END IF;
  END LOOP;
END
$preflight$;

DO $migration$
DECLARE
  target regprocedure := 'fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,uuid)'::regprocedure;
  definition text;
BEGIN
  definition := pg_get_functiondef(target);
  definition := replace(definition, E'  boundary_matches integer;\n',
    E'  boundary_matches integer;\n  segment_start numeric;\n  latest_reset_kind text;\n  latest_reset_position numeric;\n  latest_reset_payload jsonb;\n  latest_reset_created_at timestamptz;\n  later_reset_exists boolean;\n');
  -- The trigger message is its turn's first user row: never a later user row
  -- of the same turn, a superseded copy, or a compaction summary.
  definition := replace(definition,
    E'AND history.turn_id = selected_turn_id\n        AND history.active\n        AND history.item ->> ''role'' = ''user''',
    $replacement$AND history.turn_id = selected_turn_id
        AND history.item ->> 'role' = 'user'
        AND NOT EXISTS (SELECT 1 FROM session_events summary_event
          WHERE summary_event.account_id = p_account_id
            AND summary_event.workspace_id = p_source_workspace_id
            AND summary_event.session_id = p_source_session_id
            AND summary_event.type = 'session.context.compacted'
            AND summary_event.payload ->> 'summaryPosition' = history.position::text)
        AND NOT EXISTS (SELECT 1 FROM session_history_items earlier_user
          WHERE earlier_user.account_id = history.account_id
            AND earlier_user.workspace_id = history.workspace_id
            AND earlier_user.session_id = history.session_id
            AND earlier_user.turn_id = selected_turn_id
            AND earlier_user.item ->> 'role' = 'user'
            AND earlier_user.position < history.position)$replacement$);
  definition := replace(definition,
    E'AND history.turn_id = selected_event.turn_id\n        AND history.active\n        AND history.item ->> ''role'' = ''assistant''',
    E'AND history.turn_id = selected_event.turn_id\n        AND history.item ->> ''role'' = ''assistant''');
  definition := replace(definition, $old$  -- Compaction can replace an earlier prefix with a summary containing later
  -- messages. Fail closed rather than leak those later messages into this fork.
  IF EXISTS (SELECT 1 FROM session_history_items history
    WHERE history.account_id = p_account_id AND history.workspace_id = p_source_workspace_id
      AND history.session_id = p_source_session_id
      AND history.position <= boundary_position
      AND ((NOT history.active AND NOT EXISTS (
      SELECT 1 FROM session_events compaction_event
      JOIN session_history_items summary_history
        ON summary_history.account_id = compaction_event.account_id
        AND summary_history.workspace_id = compaction_event.workspace_id
        AND summary_history.session_id = compaction_event.session_id
        AND summary_history.position::text = compaction_event.payload ->> 'summaryPosition'
        AND summary_history.active
      WHERE compaction_event.account_id = p_account_id
        AND compaction_event.workspace_id = p_source_workspace_id
        AND compaction_event.session_id = p_source_session_id
        AND compaction_event.type = 'session.context.compacted'
        AND compaction_event.sequence < selected_event.sequence
        AND history.position < summary_history.position
        AND summary_history.position <= boundary_position
    )) OR (history.active AND history.position <> trunc(history.position) AND NOT ((
          history.item ->> 'type' = 'message'
          AND history.item ->> 'role' = 'developer'
          AND jsonb_typeof(history.item -> 'content') = 'string'
          AND starts_with(history.item ->> 'content', E'<opengeni_skill_catalog>\n')
          AND right(history.item ->> 'content', length(E'\n</opengeni_skill_catalog>')) = E'\n</opengeni_skill_catalog>'
        ) IS TRUE) AND (
          history.item ->> 'type' = 'unknown'
          AND history.item #> '{opengeniReasoningConfiguration,version}' = '1'::jsonb
          AND history.item #>> '{opengeniReasoningConfiguration,baselineEffort}'
            IN ('low', 'medium', 'high', 'xhigh', 'max')
          AND history.item #>> '{opengeniReasoningConfiguration,effort}'
            IN ('low', 'medium', 'high', 'xhigh', 'max')
          AND jsonb_typeof(history.item #> '{opengeniReasoningConfiguration,turnId}') = 'string'
          AND history.item #>> '{providerData,type}' = 'configuration_update'
          AND history.item #>> '{providerData,reasoning,effort}' =
            history.item #>> '{opengeniReasoningConfiguration,effort}'
        ) IS NOT TRUE)
        OR (history.active AND history.item ->> 'type' = 'compaction' AND NOT EXISTS (
      SELECT 1 FROM session_events compaction_event
      WHERE compaction_event.account_id = p_account_id
        AND compaction_event.workspace_id = p_source_workspace_id
        AND compaction_event.session_id = p_source_session_id
        AND compaction_event.type = 'session.context.compacted'
        AND compaction_event.payload ->> 'summaryPosition' = history.position::text
        AND compaction_event.sequence < selected_event.sequence
    )))) THEN
    RAISE EXCEPTION 'Forking at a message is unavailable after conversation compaction' USING ERRCODE = '22023';
  END IF;
$old$, $new$  -- The history live at the boundary starts at the latest context reset
  -- positioned at or before it (see migration 0778).
  SELECT reset.kind, reset.position, reset.payload, reset.created_at
    INTO latest_reset_kind, latest_reset_position, latest_reset_payload, latest_reset_created_at
  FROM (
    SELECT 'compaction' AS kind, summary_history.position, compaction_event.payload,
      summary_history.created_at
    FROM session_events compaction_event
    JOIN session_history_items summary_history
      ON summary_history.account_id = compaction_event.account_id
      AND summary_history.workspace_id = compaction_event.workspace_id
      AND summary_history.session_id = compaction_event.session_id
      AND summary_history.position::text = compaction_event.payload ->> 'summaryPosition'
    WHERE compaction_event.account_id = p_account_id
      AND compaction_event.workspace_id = p_source_workspace_id
      AND compaction_event.session_id = p_source_session_id
      AND compaction_event.type = 'session.context.compacted'
      AND summary_history.position <= boundary_position
    UNION ALL
    SELECT 'clear', marker_history.position, clear_event.payload, marker_history.created_at
    FROM session_events clear_event
    JOIN session_history_items marker_history
      ON marker_history.account_id = clear_event.account_id
      AND marker_history.workspace_id = clear_event.workspace_id
      AND marker_history.session_id = clear_event.session_id
      AND marker_history.position::text = clear_event.payload ->> 'markerPosition'
    WHERE clear_event.account_id = p_account_id
      AND clear_event.workspace_id = p_source_workspace_id
      AND clear_event.session_id = p_source_session_id
      AND clear_event.type = 'session.context.cleared'
      AND marker_history.position <= boundary_position
  ) reset
  ORDER BY reset.position DESC
  LIMIT 1;
  IF latest_reset_kind IS NULL THEN
    segment_start := '-Infinity'::numeric;
  ELSIF latest_reset_kind = 'clear' THEN
    segment_start := latest_reset_position;
  ELSIF jsonb_typeof(latest_reset_payload -> 'replacementFromPosition') = 'number' THEN
    segment_start := (latest_reset_payload ->> 'replacementFromPosition')::numeric;
  ELSE
    -- An earlier receipt: the replacement rows share the summary's insert
    -- transaction, positioned after every row that existed before it. This
    -- identifies that transaction's rows; it never orders rows by time.
    SELECT coalesce(floor(max(earlier.position)) + 1, 0) INTO segment_start
    FROM session_history_items earlier
    WHERE earlier.account_id = p_account_id AND earlier.workspace_id = p_source_workspace_id
      AND earlier.session_id = p_source_session_id
      AND earlier.position < latest_reset_position
      AND earlier.created_at <> latest_reset_created_at;
  END IF;
  later_reset_exists := EXISTS (
    SELECT 1 FROM session_events reset_event
    JOIN session_history_items reset_history
      ON reset_history.account_id = reset_event.account_id
      AND reset_history.workspace_id = reset_event.workspace_id
      AND reset_history.session_id = reset_event.session_id
      AND reset_history.position::text = CASE reset_event.type
        WHEN 'session.context.compacted' THEN reset_event.payload ->> 'summaryPosition'
        ELSE reset_event.payload ->> 'markerPosition' END
    WHERE reset_event.account_id = p_account_id
      AND reset_event.workspace_id = p_source_workspace_id
      AND reset_event.session_id = p_source_session_id
      AND reset_event.type IN ('session.context.compacted', 'session.context.cleared')
      AND reset_history.position > boundary_position
  );
  -- Fail closed unless the retained rows prove exactly that live history.
  IF (latest_reset_kind = 'compaction' AND (
      latest_reset_position <> trunc(latest_reset_position)
      OR segment_start > latest_reset_position))
    OR EXISTS (SELECT 1 FROM session_history_items history
      WHERE history.account_id = p_account_id AND history.workspace_id = p_source_workspace_id
        AND history.session_id = p_source_session_id
        AND history.active AND history.position < segment_start)
    OR EXISTS (SELECT 1 FROM session_history_items history
    WHERE history.account_id = p_account_id AND history.workspace_id = p_source_workspace_id
      AND history.session_id = p_source_session_id
      AND history.position >= segment_start
      AND history.position <= boundary_position
      AND ((NOT history.active AND NOT later_reset_exists)
        OR (history.position <> trunc(history.position) AND NOT ((
          history.item ->> 'type' = 'message'
          AND history.item ->> 'role' = 'developer'
          AND jsonb_typeof(history.item -> 'content') = 'string'
          AND starts_with(history.item ->> 'content', E'<opengeni_skill_catalog>\n')
          AND right(history.item ->> 'content', length(E'\n</opengeni_skill_catalog>')) = E'\n</opengeni_skill_catalog>'
        ) IS TRUE) AND (
          history.item ->> 'type' = 'unknown'
          AND history.item #> '{opengeniReasoningConfiguration,version}' = '1'::jsonb
          AND history.item #>> '{opengeniReasoningConfiguration,baselineEffort}'
            IN ('low', 'medium', 'high', 'xhigh', 'max')
          AND history.item #>> '{opengeniReasoningConfiguration,effort}'
            IN ('low', 'medium', 'high', 'xhigh', 'max')
          AND jsonb_typeof(history.item #> '{opengeniReasoningConfiguration,turnId}') = 'string'
          AND history.item #>> '{providerData,type}' = 'configuration_update'
          AND history.item #>> '{providerData,reasoning,effort}' =
            history.item #>> '{opengeniReasoningConfiguration,effort}'
        ) IS NOT TRUE)
        OR (history.item ->> 'type' = 'compaction' AND NOT EXISTS (
      SELECT 1 FROM session_events compaction_event
      WHERE compaction_event.account_id = p_account_id
        AND compaction_event.workspace_id = p_source_workspace_id
        AND compaction_event.session_id = p_source_session_id
        AND compaction_event.type = 'session.context.compacted'
        AND compaction_event.payload ->> 'summaryPosition' = history.position::text
    )))) THEN
    RAISE EXCEPTION 'Forking at a message is unavailable after conversation compaction' USING ERRCODE = '22023';
  END IF;
$new$);
  definition := replace(definition,
    E'AND history.session_id = p_source_session_id AND history.active\n        AND history.position <= boundary_position',
    E'AND history.session_id = p_source_session_id\n        AND history.position >= segment_start AND history.position <= boundary_position');
  -- The copied rows were live at the boundary, so they are live in the fork.
  definition := replace(definition, E'      source_item.item_codec_version, source_item.active,\n',
    E'      source_item.item_codec_version, true,\n');
  definition := replace(definition,
    E'AND source_item.session_id = p_source_session_id AND source_item.active\n      AND source_item.position <= boundary_position',
    E'AND source_item.session_id = p_source_session_id\n      AND source_item.position >= segment_start\n      AND source_item.position <= boundary_position');
  definition := replace(definition,
    E'  -- boundary from timestamps or manufacture model input from audit events.\n',
    E'  -- boundary from timestamp order or manufacture model input from audit events.\n');
  EXECUTE definition;
END
$migration$;

DO $postflight$
DECLARE
  definition text;
BEGIN
  definition := pg_get_functiondef('fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,uuid)'::regprocedure);
  IF strpos(definition, 'latest_reset_kind') = 0
    OR strpos(definition, 'Compaction can replace an earlier prefix') > 0
    OR strpos(definition, 'earlier_user.position < history.position') = 0
    OR strpos(definition, 'source_item.position >= segment_start') = 0
  THEN
    RAISE EXCEPTION 'message fork as-of history rewrite was not installed';
  END IF;
END
$postflight$;
