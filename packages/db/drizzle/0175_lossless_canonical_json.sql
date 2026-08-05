-- deployment-mode: rolling
-- Canonical OpenGeni JSON is stored in full. Bounded payloads are derived only
-- for explicit monitoring/public projections; the write boundary must not
-- replace source bytes merely to satisfy a timeline preview envelope.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

DROP TRIGGER IF EXISTS session_events_bound_payload_before_insert ON session_events;
DROP FUNCTION IF EXISTS opengeni_private.bound_session_event_payload();

-- Retain a bounded, explicit monitoring projection without mutating the
-- canonical row. Unlike the retired write guard, this read helper accurately
-- reports that authorized callers can request the full retained payload.
CREATE OR REPLACE FUNCTION opengeni_private.project_session_event_payload(source_payload jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT CASE
    WHEN octet_length(source_payload::text) <= 65536 THEN source_payload
    ELSE jsonb_build_object(
      '_monitoring', jsonb_build_object(
        'payloadMode', 'summary',
        'payloadTruncated', true,
        'originalBytes', octet_length(source_payload::text),
        'fullPayload', 'request payloadMode=full explicitly'
      ),
      'preview', left(source_payload::text, 2048)
    )
  END
$function$;

ALTER TABLE session_events
  DROP CONSTRAINT IF EXISTS session_events_payload_bytes_check;

ALTER TABLE session_realtime_entries
  DROP CONSTRAINT IF EXISTS session_realtime_entries_text_check,
  DROP CONSTRAINT IF EXISTS session_realtime_entries_payload_check;

COMMENT ON COLUMN session_events.payload IS
  'Canonical lossless event payload. Explicit read/transport projections apply their own byte bounds.';
COMMENT ON COLUMN session_history_items.item IS
  'Canonical lossless model/history item; unsafe PostgreSQL JSON strings and graphs use the application codec envelope.';
COMMENT ON COLUMN rig_changes.payload IS
  'Canonical lossless rig-change payload; public summaries are separate projections.';
COMMENT ON COLUMN rig_changes.verification IS
  'Canonical lossless rig-verification result; public summaries are separate projections.';