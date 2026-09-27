-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_events_meaningful_attention_v2_idx
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
AND (type <> 'agent.message.completed' OR coalesce(payload ->> 'phase', '') <> 'commentary')
AND (type <> 'turn.completed' OR (
  NOT (payload ?| array['maintenance', 'segmentLimit'])
  AND coalesce(nullif(payload -> 'output', 'null'::jsonb), payload -> 'result') IS NOT NULL
  AND coalesce(nullif(payload -> 'output', 'null'::jsonb), payload -> 'result') NOT IN ('null'::jsonb, '""'::jsonb)
));
