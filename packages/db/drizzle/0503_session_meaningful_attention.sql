-- deployment-mode: maintenance
-- Old attention writers do not preserve explicit unread intent. Drain them;
-- do not restart pre-0503 API/control/turn workers after this migration.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' OR jsonb_array_length(roles) NOT BETWEEN 1 AND 16
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}') OR octet_length(item #>> '{}') > 63)
    OR EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
      WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION 'meaningful attention migration requires stopped application roles' USING ERRCODE = '55000';
  END IF;
END $drain$;

ALTER TABLE session_pins ADD COLUMN manually_unread_through integer;

-- One reverse probe per rail/tree row; raw deltas and housekeeping never enter
-- this index. Keep the predicate aligned with session-meaningful-events.ts.
CREATE INDEX session_events_meaningful_attention_idx
ON session_events (workspace_id, session_id, sequence)
WHERE type IN (
  'agent.message.completed', 'turn.completed', 'turn.failed',
  'session.requiresAction', 'session.humanInput.requested',
  'tool.auth_needed', 'credential.auth_needed', 'goal.completed', 'goal.paused',
  'goal.progress', 'goal.rewrite.proposed', 'rig.setup.failed',
  'sandbox.operation.failed', 'sandbox.box.lost', 'workspace.revision.degraded',
  'machine.op.failed', 'machine.link.lost', 'session.event.envelope_omitted'
)
AND duplicate_of_event_id IS NULL
AND (turn_association IS NULL OR turn_association = 'current')
AND (type <> 'agent.message.completed' OR coalesce(payload ->> 'text', '') <> '')
AND (type <> 'turn.completed' OR (
  NOT (payload ?| array['maintenance', 'segmentLimit'])
  AND coalesce(nullif(payload -> 'output', 'null'::jsonb), payload -> 'result') IS NOT NULL
  AND coalesce(nullif(payload -> 'output', 'null'::jsonb), payload -> 'result') NOT IN ('null'::jsonb, '""'::jsonb)
));

-- Historical attention_version does not distinguish mark-unread from mark-read
-- or follow-up intent. Protect human-touched rows only if meaningful content is
-- still unread (or the explicit empty-session sentinel is present). Reading a
-- final followed by cleanup must NOT acquire a fabricated manual-unread fence.
-- The raw migration frontier conservatively dates ambiguous surviving intent;
-- only genuinely newer consumed work or explicit mark-read removes it.
-- No acknowledged cursor is advanced and no subject is inferred.
ALTER TABLE session_pins NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_event_cursors NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_events NO FORCE ROW LEVEL SECURITY;
UPDATE session_pins personal SET manually_unread_through = cursor.last_sequence
FROM session_event_cursors cursor
WHERE cursor.account_id = personal.account_id
  AND cursor.workspace_id = personal.workspace_id
  AND cursor.session_id = personal.session_id
  AND personal.attention_version > 0
  AND (personal.acknowledged_sequence < 0 OR EXISTS (
    SELECT 1 FROM session_events meaningful
    WHERE meaningful.workspace_id = personal.workspace_id
      AND meaningful.session_id = personal.session_id
      AND meaningful.sequence > personal.acknowledged_sequence
      AND meaningful.type IN (
        'agent.message.completed', 'turn.completed', 'turn.failed',
        'session.requiresAction', 'session.humanInput.requested',
        'tool.auth_needed', 'credential.auth_needed', 'goal.completed', 'goal.paused',
        'goal.progress', 'goal.rewrite.proposed', 'rig.setup.failed',
        'sandbox.operation.failed', 'sandbox.box.lost', 'workspace.revision.degraded',
        'machine.op.failed', 'machine.link.lost', 'session.event.envelope_omitted'
      )
      AND meaningful.duplicate_of_event_id IS NULL
      AND (meaningful.turn_association IS NULL OR meaningful.turn_association = 'current')
      AND (meaningful.type <> 'agent.message.completed' OR coalesce(meaningful.payload ->> 'text', '') <> '')
      AND (meaningful.type <> 'turn.completed' OR (
        NOT (meaningful.payload ?| array['maintenance', 'segmentLimit'])
        AND coalesce(nullif(meaningful.payload -> 'output', 'null'::jsonb), meaningful.payload -> 'result') IS NOT NULL
        AND coalesce(nullif(meaningful.payload -> 'output', 'null'::jsonb), meaningful.payload -> 'result') NOT IN ('null'::jsonb, '""'::jsonb)
      ))
  ));
ALTER TABLE session_events FORCE ROW LEVEL SECURITY;
ALTER TABLE session_event_cursors FORCE ROW LEVEL SECURITY;
ALTER TABLE session_pins FORCE ROW LEVEL SECURITY;