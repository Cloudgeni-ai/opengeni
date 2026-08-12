-- deployment-mode: rolling
-- Preserve the exact audit-event output separately from the bounded
-- model-facing result item so crash recovery can reproduce the live event.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

ALTER TABLE session_pending_tool_calls
  ADD COLUMN IF NOT EXISTS event_output jsonb,
  ADD COLUMN IF NOT EXISTS event_output_codec_version integer;

ALTER TABLE session_pending_tool_calls
  ADD CONSTRAINT session_pending_tool_calls_event_output_codec_version_chk
  CHECK (
    (event_output IS NULL AND event_output_codec_version IS NULL)
    OR (event_output IS NOT NULL AND event_output_codec_version = 1)
  ) NOT VALID;

ALTER TABLE session_pending_tool_calls
  VALIDATE CONSTRAINT session_pending_tool_calls_event_output_codec_version_chk;

COMMENT ON COLUMN session_pending_tool_calls.event_output IS
  'Lossless {value} envelope for the exact agent.toolCall.output projection retained until live publish or recovery.';
COMMENT ON COLUMN session_pending_tool_calls.event_output_codec_version IS
  'Out-of-band lossless JSON codec version for event_output; NULL denotes an older writer or no retained event output.';

CREATE OR REPLACE FUNCTION opengeni_private.guard_pending_tool_event_output_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.event_output IS NOT NULL
    AND nullif(current_setting('opengeni.account_id', true), '') IS NOT NULL
    AND current_setting('opengeni.pending_tool_event_output_v1', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'rich pending tool output requires a v1-aware settlement worker';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER session_pending_tool_calls_event_output_delete_guard
BEFORE DELETE ON session_pending_tool_calls
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.guard_pending_tool_event_output_delete();

REVOKE ALL ON FUNCTION opengeni_private.guard_pending_tool_event_output_delete() FROM PUBLIC;
