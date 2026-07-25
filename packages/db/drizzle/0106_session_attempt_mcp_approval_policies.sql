-- deployment-mode: maintenance
-- Workers are drained before this migration so no executable attempt can cross
-- the boundary without an immutable approval-policy snapshot. Closed attempts
-- are historical evidence only and receive an inert empty snapshot.
SET lock_timeout = '5s';
SET statement_timeout = '5min';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "session_turn_attempts"
    WHERE "state" <> 'closed'
    LIMIT 1
  ) THEN
    RAISE EXCEPTION
      'live session turn attempts must be drained before the MCP approval-policy cutover';
  END IF;
END
$$;

ALTER TABLE "session_turn_attempts"
  ADD COLUMN "mcp_approval_policies" jsonb NOT NULL DEFAULT '{}'::jsonb;

-- PostgreSQL installs a constant default without rewriting the historical
-- table. Remove the default immediately: every new attempt must provide its
-- claim-time snapshot explicitly.
ALTER TABLE "session_turn_attempts"
  ALTER COLUMN "mcp_approval_policies" DROP DEFAULT;
