-- deployment-mode: rolling
-- opengeni:batched-backfill batch-size=1000 lock-timeout=1s statement-timeout=30s
-- Only unfinished turns can still append usage, so only their usage events
-- need the key; candidates are found from the few open turns through
-- session_events_workspace_turn_type_idx. Each batch commits independently.
WITH candidates AS MATERIALIZED (
  SELECT usage_event.id
  FROM session_turns open_turn
  JOIN session_events usage_event
    ON usage_event.workspace_id = open_turn.workspace_id
   AND usage_event.turn_id = open_turn.id
   AND usage_event.type = 'agent.model.usage'
  WHERE open_turn.finished_at IS NULL
    AND usage_event.usage_source_key IS NULL
    AND NULLIF(usage_event.payload ->> 'sourceKey', '') IS NOT NULL
  ORDER BY usage_event.id
  LIMIT 1000
  FOR UPDATE OF usage_event
), backfilled AS (
  UPDATE session_events usage_event
  SET usage_source_key = NULLIF(usage_event.payload ->> 'sourceKey', '')
  FROM candidates
  WHERE usage_event.id = candidates.id
  RETURNING usage_event.id
)
SELECT id FROM backfilled;
