-- deployment-mode: rolling
-- opengeni:batched-backfill batch-size=500 lock-timeout=1s statement-timeout=10s
-- Existing non-user titles predate the normalization policy and have no durable
-- proof that they are safe. Preserve explicit human edits and quarantine the
-- legacy rows in independently committed batches. A contended writer aborts a
-- batch quickly and leaves the migration retryable; ordinary readers remain
-- compatible with the row-level locks throughout.
WITH quarantine_capability AS MATERIALIZED (
  SELECT pg_catalog.set_config(
    'opengeni.automatic_session_title_quarantine_v1',
    '1',
    true
  ) AS enabled
),
candidates AS MATERIALIZED (
  SELECT session.id
  FROM sessions session
  CROSS JOIN quarantine_capability capability
  WHERE capability.enabled = '1'
    AND session.title_source IS DISTINCT FROM 'user'
    AND (
      session.title IS DISTINCT FROM 'New conversation'
      OR session.title_source IS DISTINCT FROM 'agent'
    )
  ORDER BY session.id
  LIMIT 500
  FOR UPDATE OF session
)
UPDATE sessions session
SET title = 'New conversation', title_source = 'agent'
FROM candidates
WHERE session.id = candidates.id
RETURNING session.id;