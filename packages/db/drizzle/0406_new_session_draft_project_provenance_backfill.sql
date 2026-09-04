-- deployment-mode: rolling
-- opengeni:batched-backfill batch-size=500 lock-timeout=1s statement-timeout=10s
-- Convert legacy JSON provenance in independently committed, deterministic
-- batches. The runner sets the owner-only capability transaction-locally
-- before this statement; a same-query CTE cannot establish visibility for the
-- FORCE-RLS scan reliably. The partial index keeps candidate discovery and the
-- final empty batch bounded to remaining legacy rows. A contended candidate
-- aborts the transaction instead of being skipped, so the migration cannot be
-- ledgered while any locked legacy row remains.
WITH candidates AS MATERIALIZED (
  SELECT draft.id
  FROM new_session_drafts draft
  WHERE draft.session_options ? 'selectedProjectChannelId'
  ORDER BY draft.id
  LIMIT 500
  FOR UPDATE OF draft
),
backfilled AS (
  UPDATE new_session_drafts draft
  SET
    selected_project_channel_id = CASE
      WHEN jsonb_typeof(draft.session_options -> 'selectedProjectChannelId') = 'string'
        AND (draft.session_options ->> 'selectedProjectChannelId')
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN (draft.session_options ->> 'selectedProjectChannelId')::uuid
      ELSE NULL
    END,
    selected_project_compute_snapshot = CASE
      WHEN jsonb_typeof(draft.session_options -> 'selectedProjectChannelId') = 'null'
        OR (
          jsonb_typeof(draft.session_options -> 'selectedProjectChannelId') = 'string'
          AND (draft.session_options ->> 'selectedProjectChannelId')
            ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        )
      THEN
        CASE WHEN draft.session_options ? 'sandboxBackend'
          THEN jsonb_build_object('sandboxBackend', draft.session_options -> 'sandboxBackend')
          ELSE '{}'::jsonb END
        || CASE WHEN draft.session_options ? 'targetSandboxId'
          THEN jsonb_build_object('targetSandboxId', draft.session_options -> 'targetSandboxId')
          ELSE '{}'::jsonb END
        || CASE WHEN draft.session_options ? 'workingDir'
          THEN jsonb_build_object('workingDir', draft.session_options -> 'workingDir')
          ELSE '{}'::jsonb END
      ELSE NULL
    END,
    session_options = draft.session_options - 'selectedProjectChannelId'
  FROM candidates
  WHERE draft.id = candidates.id
  RETURNING draft.id
)
SELECT id
FROM backfilled;
