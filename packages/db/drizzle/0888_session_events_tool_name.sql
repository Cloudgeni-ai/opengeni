-- deployment-mode: rolling
-- Conversation-first history reads exclude tool steps but keep the
-- agent.toolCall.created rows of presented tools, matched on the tool name.
-- Reading payload ->> 'name' detoasts each excluded call's full arguments, so
-- a long history paid for every skipped call. tool_name holds the same name
-- as a short plain column that the filter reads without touching the payload.
--
-- A trigger fills it from the payload, so every writer (including binaries
-- still running during a rolling deploy) populates it identically; it is also
-- recomputed if a payload is ever rewritten. Existing rows keep NULL: readers
-- fall back to the payload only for a NULL column, which classifies them
-- exactly as before, so no historical rewrite of this large table is needed.
-- This file only takes brief catalog locks, so it commits immediately.
SET LOCAL lock_timeout = '5s';

ALTER TABLE session_events ADD COLUMN tool_name text;

CREATE FUNCTION session_events_fill_tool_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fill_tool_name$
BEGIN
  NEW.tool_name := NEW.payload ->> 'name';
  RETURN NEW;
END
$fill_tool_name$;
REVOKE ALL ON FUNCTION session_events_fill_tool_name() FROM PUBLIC;

CREATE TRIGGER session_events_fill_tool_name
  BEFORE INSERT OR UPDATE OF payload ON session_events
  FOR EACH ROW
  WHEN (NEW.type = 'agent.toolCall.created')
  EXECUTE FUNCTION session_events_fill_tool_name();
