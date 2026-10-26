-- deployment-mode: rolling
-- Exact call lookups must not detoast every skipped tool's arguments/output.
-- Extend the existing tool metadata writer rather than adding a second trigger.
-- Older binaries populate the projection through the same INSERT/UPDATE path.
-- Historical rows remain NULL and readers retain their exact payload fallback;
-- no large-table rewrite or index build is required for this projection.
SET LOCAL lock_timeout = '5s';

ALTER TABLE session_events ADD COLUMN tool_call_id text;

DROP TRIGGER session_events_fill_tool_name ON session_events;
ALTER FUNCTION session_events_fill_tool_name() RENAME TO session_events_fill_tool_identity;

CREATE OR REPLACE FUNCTION session_events_fill_tool_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fill_tool_identity$
BEGIN
  NEW.tool_name := CASE WHEN NEW.type = 'agent.toolCall.created'
    THEN NEW.payload ->> 'name' ELSE NULL END;
  NEW.tool_call_id := CASE WHEN NEW.type IN ('agent.toolCall.created', 'agent.toolCall.output')
    THEN coalesce(NEW.payload ->> 'callId', NEW.payload ->> 'call_id', NEW.payload ->> 'id')
    ELSE NULL END;
  RETURN NEW;
END
$fill_tool_identity$;
REVOKE ALL ON FUNCTION session_events_fill_tool_identity() FROM PUBLIC;

CREATE TRIGGER session_events_fill_tool_identity
  BEFORE INSERT OR UPDATE OF payload, type ON session_events
  FOR EACH ROW
  WHEN (NEW.type IN ('agent.toolCall.created', 'agent.toolCall.output')
    OR NEW.tool_name IS NOT NULL OR NEW.tool_call_id IS NOT NULL)
  EXECUTE FUNCTION session_events_fill_tool_identity();
