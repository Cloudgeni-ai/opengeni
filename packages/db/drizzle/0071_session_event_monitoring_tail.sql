-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS "session_events_workspace_session_monitoring_tail_idx"
  ON "session_events" ("workspace_id", "session_id", "sequence" DESC)
  WHERE "type" NOT IN (
    'agent.message.delta',
    'agent.reasoning.delta',
    'sandbox.command.output.delta',
    'terminal.pty.output.delta'
  );
