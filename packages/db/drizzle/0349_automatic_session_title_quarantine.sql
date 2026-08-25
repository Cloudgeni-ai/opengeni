-- deployment-mode: rolling
-- opengeni:batched-backfill batch-size=500 lock-timeout=1s statement-timeout=10s
-- Existing non-user titles predate the normalization policy and have no durable
-- proof that they are safe. Preserve explicit human edits and quarantine the
-- legacy rows in independently committed batches. The preceding concurrent
-- partial index keeps every batch and the final empty probe bounded to the
-- remaining unsafe rows instead of repeatedly scanning the cleaned prefix. A
-- contended writer aborts a batch quickly and leaves the migration retryable;
-- ordinary readers remain compatible with the row-level locks throughout.
WITH settings AS MATERIALIZED (
  SELECT 500::integer AS batch_size
),
quarantine_capability AS MATERIALIZED (
  SELECT pg_catalog.set_config(
    'opengeni.automatic_session_title_quarantine_v1',
    '1',
    true
  ) AS enabled
),
quarantine_scope AS MATERIALIZED (
  SELECT acquire_automatic_session_title_quarantine_fences_v1(
    settings.batch_size
  ) AS workspace_ids
  FROM settings
  CROSS JOIN quarantine_capability capability
  WHERE capability.enabled = '1'
),
candidates AS MATERIALIZED (
  SELECT session.id
  FROM sessions session
  CROSS JOIN quarantine_scope scope
  WHERE session.workspace_id = ANY(scope.workspace_ids)
    AND session.title_source IS DISTINCT FROM 'user'
    AND (
      session.title IS DISTINCT FROM 'New conversation'
      OR session.title_source IS DISTINCT FROM 'agent'
    )
  ORDER BY session.id
  LIMIT (SELECT batch_size FROM settings)
  FOR UPDATE OF session
),
quarantined AS (
  UPDATE sessions session
  SET title = 'New conversation',
      title_source = 'agent',
      last_sequence = session.last_sequence + 1
  FROM candidates
  WHERE session.id = candidates.id
  RETURNING
    session.id,
    session.account_id,
    session.workspace_id,
    session.last_sequence
)
INSERT INTO session_events (
  account_id,
  workspace_id,
  session_id,
  sequence,
  type,
  payload,
  occurred_at
)
SELECT
  quarantined.account_id,
  quarantined.workspace_id,
  quarantined.id,
  quarantined.last_sequence,
  'session.title_set',
  pg_catalog.jsonb_build_object(
    'title', 'New conversation',
    'source', 'agent'
  ),
  pg_catalog.clock_timestamp()
FROM quarantined
RETURNING session_id AS id;