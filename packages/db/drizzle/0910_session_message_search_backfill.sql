-- deployment-mode: rolling
-- opengeni:batched-backfill batch-size=25 lock-timeout=1s statement-timeout=5min
-- online-safety-exception: unbatched-data: each run copies only the messages of one bounded batch of 25 sessions
-- Copy the existing user and completed assistant messages into
-- session_message_search_texts, 25 sessions per independently committed
-- batch, walking sessions in (workspace_id, id) order from the progress row.
-- The runner sets 0909's owner-only capability transaction-locally first.
-- 0909's trigger already indexes every message written since, so a batch and
-- a concurrent writer can only meet on the same event, which ON CONFLICT
-- absorbs. The last batch finds no session after the cursor and returns no
-- row, which ends the backfill. The INSERT has no RETURNING: its rows are
-- invisible to SELECT policies without a search pattern, and a data-modifying
-- CTE runs to completion whether or not it is referenced.
WITH batch AS MATERIALIZED (
  SELECT session_row.workspace_id, session_row.id
  FROM sessions session_row, opengeni_private.session_message_search_backfill progress
  WHERE progress.workspace_id IS NULL
    OR (session_row.workspace_id, session_row.id) > (progress.workspace_id, progress.session_id)
  ORDER BY session_row.workspace_id, session_row.id
  LIMIT 25
),
indexed AS (
  INSERT INTO session_message_search_texts
    (account_id, workspace_id, session_id, sequence, encoded, text)
  SELECT event.account_id, event.workspace_id, event.session_id, event.sequence,
    starts_with(event.payload->>'text', 'opengeni_lossless_json_string_v2_81f06e15:'),
    event.payload->>'text'
  FROM batch
  JOIN session_events event
    ON event.workspace_id = batch.workspace_id
    AND event.session_id = batch.id
    AND event.type IN ('user.message', 'agent.message.completed')
  WHERE jsonb_typeof(event.payload->'text') = 'string'
  ON CONFLICT DO NOTHING
),
last_session AS (
  SELECT batch.workspace_id, batch.id
  FROM batch
  ORDER BY batch.workspace_id DESC, batch.id DESC
  LIMIT 1
)
UPDATE opengeni_private.session_message_search_backfill progress
SET workspace_id = last_session.workspace_id, session_id = last_session.id
FROM last_session
RETURNING progress.session_id;
