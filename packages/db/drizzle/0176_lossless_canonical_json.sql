-- deployment-mode: rolling
-- Canonical OpenGeni JSON is stored in full. Bounded payloads are derived only
-- for explicit monitoring/public projections; the write boundary must not
-- replace source bytes merely to satisfy a timeline preview envelope.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

-- Codec/version truth is out-of-band. Existing rows and writes from an older
-- application remain NULL and are therefore literal data, even when a value is
-- byte-for-byte identical to a valid active marker. The new application writes
-- version 1 only in the same statement as its encoded value; there is
-- deliberately no database or application default during the rolling window.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS initial_message_codec_version integer;
ALTER TABLE session_realtime_entries
  ADD COLUMN IF NOT EXISTS text_codec_version integer,
  ADD COLUMN IF NOT EXISTS payload_codec_version integer;
ALTER TABLE knowledge_memories
  ADD COLUMN IF NOT EXISTS text_codec_version integer;
ALTER TABLE session_turns
  ADD COLUMN IF NOT EXISTS prompt_codec_version integer;
ALTER TABLE session_system_updates
  ADD COLUMN IF NOT EXISTS summary_codec_version integer,
  ADD COLUMN IF NOT EXISTS payload_codec_version integer;
ALTER TABLE session_system_update_outbox
  ADD COLUMN IF NOT EXISTS summary_codec_version integer,
  ADD COLUMN IF NOT EXISTS payload_codec_version integer;
ALTER TABLE session_events
  ADD COLUMN IF NOT EXISTS payload_codec_version integer;
ALTER TABLE agent_run_states
  ADD COLUMN IF NOT EXISTS serialized_run_state_codec_version integer,
  ADD COLUMN IF NOT EXISTS pending_approvals_codec_version integer;
ALTER TABLE session_history_items
  ADD COLUMN IF NOT EXISTS item_codec_version integer;
ALTER TABLE session_pending_tool_calls
  ADD COLUMN IF NOT EXISTS call_item_codec_version integer,
  ADD COLUMN IF NOT EXISTS result_item_codec_version integer;
ALTER TABLE sandbox_session_envelopes
  ADD COLUMN IF NOT EXISTS envelope_codec_version integer;
ALTER TABLE session_recordings
  ADD COLUMN IF NOT EXISTS reason_codec_version integer;
ALTER TABLE host_export_dead_letters
  ADD COLUMN IF NOT EXISTS envelope_codec_version integer;
ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS metadata_codec_version integer;
ALTER TABLE rig_changes
  ADD COLUMN IF NOT EXISTS payload_codec_version integer,
  ADD COLUMN IF NOT EXISTS verification_codec_version integer;
ALTER TABLE transcription_recordings
  ADD COLUMN IF NOT EXISTS transcript_text_codec_version integer;
ALTER TABLE transcription_recording_segments
  ADD COLUMN IF NOT EXISTS transcript_text_codec_version integer;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_initial_message_codec_version_chk
  CHECK (initial_message_codec_version IS NULL OR initial_message_codec_version = 1) NOT VALID;
ALTER TABLE session_realtime_entries
  ADD CONSTRAINT session_realtime_entries_text_codec_version_chk
  CHECK (text_codec_version IS NULL OR text_codec_version = 1) NOT VALID,
  ADD CONSTRAINT session_realtime_entries_payload_codec_version_chk
  CHECK (payload_codec_version IS NULL OR payload_codec_version = 1) NOT VALID;
ALTER TABLE knowledge_memories
  ADD CONSTRAINT knowledge_memories_text_codec_version_chk
  CHECK (text_codec_version IS NULL OR text_codec_version = 1) NOT VALID;
ALTER TABLE session_turns
  ADD CONSTRAINT session_turns_prompt_codec_version_chk
  CHECK (prompt_codec_version IS NULL OR prompt_codec_version = 1) NOT VALID;
ALTER TABLE session_system_updates
  ADD CONSTRAINT session_system_updates_summary_codec_version_chk
  CHECK (summary_codec_version IS NULL OR summary_codec_version = 1) NOT VALID,
  ADD CONSTRAINT session_system_updates_payload_codec_version_chk
  CHECK (payload_codec_version IS NULL OR payload_codec_version = 1) NOT VALID;
ALTER TABLE session_system_update_outbox
  ADD CONSTRAINT session_system_update_outbox_summary_codec_version_chk
  CHECK (summary_codec_version IS NULL OR summary_codec_version = 1) NOT VALID,
  ADD CONSTRAINT session_system_update_outbox_payload_codec_version_chk
  CHECK (payload_codec_version IS NULL OR payload_codec_version = 1) NOT VALID;
ALTER TABLE session_events
  ADD CONSTRAINT session_events_payload_codec_version_chk
  CHECK (payload_codec_version IS NULL OR payload_codec_version = 1) NOT VALID;
ALTER TABLE agent_run_states
  ADD CONSTRAINT agent_run_states_serialized_codec_version_chk
  CHECK (serialized_run_state_codec_version IS NULL OR serialized_run_state_codec_version = 1) NOT VALID,
  ADD CONSTRAINT agent_run_states_pending_codec_version_chk
  CHECK (pending_approvals_codec_version IS NULL OR pending_approvals_codec_version = 1) NOT VALID;
ALTER TABLE session_history_items
  ADD CONSTRAINT session_history_items_item_codec_version_chk
  CHECK (item_codec_version IS NULL OR item_codec_version = 1) NOT VALID;
ALTER TABLE session_pending_tool_calls
  ADD CONSTRAINT session_pending_tool_calls_call_codec_version_chk
  CHECK (call_item_codec_version IS NULL OR call_item_codec_version = 1) NOT VALID,
  ADD CONSTRAINT session_pending_tool_calls_result_codec_version_chk
  CHECK (result_item_codec_version IS NULL OR result_item_codec_version = 1) NOT VALID;
ALTER TABLE sandbox_session_envelopes
  ADD CONSTRAINT sandbox_session_envelopes_codec_version_chk
  CHECK (envelope_codec_version IS NULL OR envelope_codec_version = 1) NOT VALID;
ALTER TABLE session_recordings
  ADD CONSTRAINT session_recordings_reason_codec_version_chk
  CHECK (reason_codec_version IS NULL OR reason_codec_version = 1) NOT VALID;
ALTER TABLE host_export_dead_letters
  ADD CONSTRAINT host_export_dead_letters_codec_version_chk
  CHECK (envelope_codec_version IS NULL OR envelope_codec_version = 1) NOT VALID;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_metadata_codec_version_chk
  CHECK (metadata_codec_version IS NULL OR metadata_codec_version = 1) NOT VALID;
ALTER TABLE rig_changes
  ADD CONSTRAINT rig_changes_payload_codec_version_chk
  CHECK (payload_codec_version IS NULL OR payload_codec_version = 1) NOT VALID,
  ADD CONSTRAINT rig_changes_verification_codec_version_chk
  CHECK (verification_codec_version IS NULL OR verification_codec_version = 1) NOT VALID;
ALTER TABLE transcription_recordings
  ADD CONSTRAINT transcription_recordings_text_codec_version_chk
  CHECK (transcript_text_codec_version IS NULL OR transcript_text_codec_version = 1) NOT VALID;
ALTER TABLE transcription_recording_segments
  ADD CONSTRAINT transcription_recording_segments_text_codec_version_chk
  CHECK (transcript_text_codec_version IS NULL OR transcript_text_codec_version = 1) NOT VALID;

-- The claim function has an explicit return shape, so carry the out-of-band
-- versions with the claimed canonical fields.
DROP FUNCTION opengeni_private.claim_session_system_update_outbox(integer);
CREATE FUNCTION opengeni_private.claim_session_system_update_outbox(p_limit integer)
RETURNS TABLE (
  id uuid, account_id uuid, workspace_id uuid, source_session_id uuid,
  target_session_id uuid, dedupe_key text, kind text, classification text,
  source_id text, summary text, summary_codec_version integer,
  payload jsonb, payload_codec_version integer, lineage jsonb,
  personal_connection_delegations jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
    WITH claimed AS (
      SELECT o.id FROM session_system_update_outbox o
      WHERE o.status = 'pending'
      ORDER BY o.created_at, o.id
      FOR UPDATE SKIP LOCKED
      LIMIT greatest(1, least(coalesce(p_limit, 100), 100))
    )
    UPDATE session_system_update_outbox o
    SET attempts = o.attempts + 1, updated_at = now()
    FROM claimed c WHERE o.id = c.id
    RETURNING o.id, o.account_id, o.workspace_id, o.source_session_id,
      o.target_session_id, o.dedupe_key, o.kind, o.classification,
      o.source_id, o.summary, o.summary_codec_version,
      o.payload, o.payload_codec_version, o.lineage,
      o.personal_connection_delegations;
END
$function$;
REVOKE ALL ON FUNCTION opengeni_private.claim_session_system_update_outbox(integer) FROM PUBLIC;
DO $block$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_session_system_update_outbox(integer)
      TO opengeni_app;
  END IF;
END
$block$;

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
  'Canonical model/history item. PostgreSQL-unsafe string code units use a reversible per-string encoding that leaves structural JSON keys queryable.';
COMMENT ON COLUMN rig_changes.payload IS
  'Canonical lossless rig-change payload; public summaries are separate projections.';
COMMENT ON COLUMN rig_changes.verification IS
  'Canonical lossless rig-verification result; public summaries are separate projections.';
COMMENT ON COLUMN session_pending_tool_calls.call_item IS
  'Canonical pending SDK call item; structural JSON keys remain SQL-queryable.';
COMMENT ON COLUMN session_pending_tool_calls.result_item IS
  'Canonical pending SDK result item; structural JSON keys remain SQL-queryable.';
COMMENT ON COLUMN session_system_updates.payload IS
  'Canonical machine-input payload; public monitoring projections are separate.';
COMMENT ON COLUMN knowledge_memories.text IS
  'Canonical exact memory text; PostgreSQL-unsafe code units use the application text codec.';
COMMENT ON COLUMN audit_events.metadata IS
  'Canonical audit metadata; value-bearing secret audit fields remain prohibited by their domain contract.';
