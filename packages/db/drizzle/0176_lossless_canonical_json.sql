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
ALTER TABLE host_export_outbox
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
  ADD COLUMN IF NOT EXISTS envelope_codec_version integer,
  ADD COLUMN IF NOT EXISTS event_payload_codec_version integer;
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
ALTER TABLE host_export_outbox
  ADD CONSTRAINT host_export_outbox_payload_codec_version_chk
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
  CHECK (envelope_codec_version IS NULL OR envelope_codec_version = 1) NOT VALID,
  ADD CONSTRAINT host_export_dead_letters_event_payload_codec_version_chk
  CHECK (event_payload_codec_version IS NULL OR event_payload_codec_version = 1) NOT VALID;
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

-- During the rolling window, an old application can update a protected value
-- on a row whose companion is already 1 while omitting the unknown companion
-- column. Preserve unrelated updates, but reset codec truth to literal NULL
-- when such an identified old writer changes protected content without also
-- changing its companion. New createDb connections carry a distinct startup
-- application_name; supported injected/embedded handles set the transaction-
-- local writer GUC from the shared RLS context hook.
CREATE OR REPLACE FUNCTION opengeni_private.fence_legacy_lossless_content_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF current_setting('opengeni.lossless_content_writer', true) = '1'
    OR current_setting('application_name', true) = 'opengeni-lossless-v1' THEN
    RETURN NEW;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'sessions' THEN
      IF NEW.initial_message IS DISTINCT FROM OLD.initial_message
        AND NEW.initial_message_codec_version IS NOT DISTINCT FROM OLD.initial_message_codec_version THEN
        NEW.initial_message_codec_version := NULL;
      END IF;
    WHEN 'session_realtime_entries' THEN
      IF NEW.text IS DISTINCT FROM OLD.text
        AND NEW.text_codec_version IS NOT DISTINCT FROM OLD.text_codec_version THEN
        NEW.text_codec_version := NULL;
      END IF;
      IF NEW.payload IS DISTINCT FROM OLD.payload
        AND NEW.payload_codec_version IS NOT DISTINCT FROM OLD.payload_codec_version THEN
        NEW.payload_codec_version := NULL;
      END IF;
    WHEN 'knowledge_memories' THEN
      IF NEW.text IS DISTINCT FROM OLD.text
        AND NEW.text_codec_version IS NOT DISTINCT FROM OLD.text_codec_version THEN
        NEW.text_codec_version := NULL;
      END IF;
    WHEN 'session_turns' THEN
      IF NEW.prompt IS DISTINCT FROM OLD.prompt
        AND NEW.prompt_codec_version IS NOT DISTINCT FROM OLD.prompt_codec_version THEN
        NEW.prompt_codec_version := NULL;
      END IF;
    WHEN 'session_system_updates' THEN
      IF NEW.summary IS DISTINCT FROM OLD.summary
        AND NEW.summary_codec_version IS NOT DISTINCT FROM OLD.summary_codec_version THEN
        NEW.summary_codec_version := NULL;
      END IF;
      IF NEW.payload IS DISTINCT FROM OLD.payload
        AND NEW.payload_codec_version IS NOT DISTINCT FROM OLD.payload_codec_version THEN
        NEW.payload_codec_version := NULL;
      END IF;
    WHEN 'session_system_update_outbox' THEN
      IF NEW.summary IS DISTINCT FROM OLD.summary
        AND NEW.summary_codec_version IS NOT DISTINCT FROM OLD.summary_codec_version THEN
        NEW.summary_codec_version := NULL;
      END IF;
      IF NEW.payload IS DISTINCT FROM OLD.payload
        AND NEW.payload_codec_version IS NOT DISTINCT FROM OLD.payload_codec_version THEN
        NEW.payload_codec_version := NULL;
      END IF;
    WHEN 'session_events' THEN
      IF NEW.payload IS DISTINCT FROM OLD.payload
        AND NEW.payload_codec_version IS NOT DISTINCT FROM OLD.payload_codec_version THEN
        NEW.payload_codec_version := NULL;
      END IF;
    WHEN 'host_export_outbox' THEN
      IF NEW.payload IS DISTINCT FROM OLD.payload
        AND NEW.payload_codec_version IS NOT DISTINCT FROM OLD.payload_codec_version THEN
        NEW.payload_codec_version := NULL;
      END IF;
    WHEN 'agent_run_states' THEN
      IF NEW.serialized_run_state IS DISTINCT FROM OLD.serialized_run_state
        AND NEW.serialized_run_state_codec_version IS NOT DISTINCT FROM OLD.serialized_run_state_codec_version THEN
        NEW.serialized_run_state_codec_version := NULL;
      END IF;
      IF NEW.pending_approvals IS DISTINCT FROM OLD.pending_approvals
        AND NEW.pending_approvals_codec_version IS NOT DISTINCT FROM OLD.pending_approvals_codec_version THEN
        NEW.pending_approvals_codec_version := NULL;
      END IF;
    WHEN 'session_history_items' THEN
      IF NEW.item IS DISTINCT FROM OLD.item
        AND NEW.item_codec_version IS NOT DISTINCT FROM OLD.item_codec_version THEN
        NEW.item_codec_version := NULL;
      END IF;
    WHEN 'session_pending_tool_calls' THEN
      IF NEW.call_item IS DISTINCT FROM OLD.call_item
        AND NEW.call_item_codec_version IS NOT DISTINCT FROM OLD.call_item_codec_version THEN
        NEW.call_item_codec_version := NULL;
      END IF;
      IF NEW.result_item IS DISTINCT FROM OLD.result_item
        AND NEW.result_item_codec_version IS NOT DISTINCT FROM OLD.result_item_codec_version THEN
        NEW.result_item_codec_version := NULL;
      END IF;
    WHEN 'sandbox_session_envelopes' THEN
      IF NEW.envelope IS DISTINCT FROM OLD.envelope
        AND NEW.envelope_codec_version IS NOT DISTINCT FROM OLD.envelope_codec_version THEN
        NEW.envelope_codec_version := NULL;
      END IF;
    WHEN 'session_recordings' THEN
      IF NEW.reason IS DISTINCT FROM OLD.reason
        AND NEW.reason_codec_version IS NOT DISTINCT FROM OLD.reason_codec_version THEN
        NEW.reason_codec_version := NULL;
      END IF;
    WHEN 'host_export_dead_letters' THEN
      IF NEW.envelope IS DISTINCT FROM OLD.envelope
        AND NEW.envelope_codec_version IS NOT DISTINCT FROM OLD.envelope_codec_version THEN
        NEW.envelope_codec_version := NULL;
      END IF;
      IF NEW.envelope #> '{event,payload}' IS DISTINCT FROM OLD.envelope #> '{event,payload}'
        AND NEW.event_payload_codec_version IS NOT DISTINCT FROM OLD.event_payload_codec_version THEN
        NEW.event_payload_codec_version := NULL;
      END IF;
    WHEN 'audit_events' THEN
      IF NEW.metadata IS DISTINCT FROM OLD.metadata
        AND NEW.metadata_codec_version IS NOT DISTINCT FROM OLD.metadata_codec_version THEN
        NEW.metadata_codec_version := NULL;
      END IF;
    WHEN 'rig_changes' THEN
      IF NEW.payload IS DISTINCT FROM OLD.payload
        AND NEW.payload_codec_version IS NOT DISTINCT FROM OLD.payload_codec_version THEN
        NEW.payload_codec_version := NULL;
      END IF;
      IF NEW.verification IS DISTINCT FROM OLD.verification
        AND NEW.verification_codec_version IS NOT DISTINCT FROM OLD.verification_codec_version THEN
        NEW.verification_codec_version := NULL;
      END IF;
    WHEN 'transcription_recordings' THEN
      IF NEW.transcript_text IS DISTINCT FROM OLD.transcript_text
        AND NEW.transcript_text_codec_version IS NOT DISTINCT FROM OLD.transcript_text_codec_version THEN
        NEW.transcript_text_codec_version := NULL;
      END IF;
    WHEN 'transcription_recording_segments' THEN
      IF NEW.transcript_text IS DISTINCT FROM OLD.transcript_text
        AND NEW.transcript_text_codec_version IS NOT DISTINCT FROM OLD.transcript_text_codec_version THEN
        NEW.transcript_text_codec_version := NULL;
      END IF;
    ELSE
      RAISE EXCEPTION 'unsupported lossless-content fence table: %', TG_TABLE_NAME;
  END CASE;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS sessions_lossless_legacy_update_fence ON sessions;
CREATE TRIGGER sessions_lossless_legacy_update_fence
BEFORE UPDATE OF initial_message ON sessions
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();
DROP TRIGGER IF EXISTS session_realtime_entries_lossless_legacy_update_fence ON session_realtime_entries;
CREATE TRIGGER session_realtime_entries_lossless_legacy_update_fence
BEFORE UPDATE OF text, payload ON session_realtime_entries
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();
DROP TRIGGER IF EXISTS knowledge_memories_lossless_legacy_update_fence ON knowledge_memories;
CREATE TRIGGER knowledge_memories_lossless_legacy_update_fence
BEFORE UPDATE OF text ON knowledge_memories
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();
DROP TRIGGER IF EXISTS session_turns_lossless_legacy_update_fence ON session_turns;
CREATE TRIGGER session_turns_lossless_legacy_update_fence
BEFORE UPDATE OF prompt ON session_turns
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();
DROP TRIGGER IF EXISTS session_system_updates_lossless_legacy_update_fence ON session_system_updates;
CREATE TRIGGER session_system_updates_lossless_legacy_update_fence
BEFORE UPDATE OF summary, payload ON session_system_updates
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();
DROP TRIGGER IF EXISTS session_system_update_outbox_lossless_legacy_update_fence ON session_system_update_outbox;
CREATE TRIGGER session_system_update_outbox_lossless_legacy_update_fence
BEFORE UPDATE OF summary, payload ON session_system_update_outbox
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();
DROP TRIGGER IF EXISTS session_events_lossless_legacy_update_fence ON session_events;
CREATE TRIGGER session_events_lossless_legacy_update_fence
BEFORE UPDATE OF payload ON session_events
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();
DROP TRIGGER IF EXISTS host_export_outbox_lossless_legacy_update_fence ON host_export_outbox;
CREATE TRIGGER host_export_outbox_lossless_legacy_update_fence
BEFORE UPDATE OF payload ON host_export_outbox
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();
DROP TRIGGER IF EXISTS agent_run_states_lossless_legacy_update_fence ON agent_run_states;
CREATE TRIGGER agent_run_states_lossless_legacy_update_fence
BEFORE UPDATE OF serialized_run_state, pending_approvals ON agent_run_states
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();
DROP TRIGGER IF EXISTS session_history_items_lossless_legacy_update_fence ON session_history_items;
CREATE TRIGGER session_history_items_lossless_legacy_update_fence
BEFORE UPDATE OF item ON session_history_items
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();
DROP TRIGGER IF EXISTS session_pending_tool_calls_lossless_legacy_update_fence ON session_pending_tool_calls;
CREATE TRIGGER session_pending_tool_calls_lossless_legacy_update_fence
BEFORE UPDATE OF call_item, result_item ON session_pending_tool_calls
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();
DROP TRIGGER IF EXISTS sandbox_session_envelopes_lossless_legacy_update_fence ON sandbox_session_envelopes;
CREATE TRIGGER sandbox_session_envelopes_lossless_legacy_update_fence
BEFORE UPDATE OF envelope ON sandbox_session_envelopes
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();
DROP TRIGGER IF EXISTS session_recordings_lossless_legacy_update_fence ON session_recordings;
CREATE TRIGGER session_recordings_lossless_legacy_update_fence
BEFORE UPDATE OF reason ON session_recordings
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();
DROP TRIGGER IF EXISTS host_export_dead_letters_lossless_legacy_update_fence ON host_export_dead_letters;
CREATE TRIGGER host_export_dead_letters_lossless_legacy_update_fence
BEFORE UPDATE OF envelope ON host_export_dead_letters
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();
DROP TRIGGER IF EXISTS audit_events_lossless_legacy_update_fence ON audit_events;
CREATE TRIGGER audit_events_lossless_legacy_update_fence
BEFORE UPDATE OF metadata ON audit_events
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();
DROP TRIGGER IF EXISTS rig_changes_lossless_legacy_update_fence ON rig_changes;
CREATE TRIGGER rig_changes_lossless_legacy_update_fence
BEFORE UPDATE OF payload, verification ON rig_changes
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();
DROP TRIGGER IF EXISTS transcription_recordings_lossless_legacy_update_fence ON transcription_recordings;
CREATE TRIGGER transcription_recordings_lossless_legacy_update_fence
BEFORE UPDATE OF transcript_text ON transcription_recordings
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();
DROP TRIGGER IF EXISTS transcription_recording_segments_lossless_legacy_update_fence ON transcription_recording_segments;
CREATE TRIGGER transcription_recording_segments_lossless_legacy_update_fence
BEFORE UPDATE OF transcript_text ON transcription_recording_segments
FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();

REVOKE ALL ON FUNCTION opengeni_private.fence_legacy_lossless_content_update() FROM PUBLIC;

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

-- Keep the published claim_host_export_batch signature and ACL stable. The
-- deferred producer writes the session-event storage payload and its out-of-
-- band truth atomically; the application reads immutable sidecars under the
-- exact current lease in the same transaction as the existing claim call.
DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.enqueue_host_session_event_export()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      v_enabled boolean;
      v_initiator jsonb;
      v_context jsonb := '{}'::jsonb;
      v_origin text;
      v_payload_bytes integer;
    BEGIN
      IF NEW.type IN (
        'agent.message.delta', 'agent.reasoning.delta',
        'sandbox.command.output.delta', 'terminal.pty.output.delta'
      ) THEN
        RETURN NEW;
      END IF;

      SELECT c.session_events_enabled INTO v_enabled
      FROM %1$I.host_export_config c WHERE c.id = 1
      FOR SHARE;
      IF coalesce(v_enabled, false) = false THEN
        RETURN NEW;
      END IF;

      IF NEW.turn_id IS NOT NULL THEN
        SELECT
          CASE WHEN octet_length(t.initiator_subject_id) <= 1024 THEN
            jsonb_strip_nulls(jsonb_build_object(
              'kind', t.initiator_kind,
              'subjectId', t.initiator_subject_id,
              'label', CASE
                WHEN jsonb_typeof(t.initiator_context -> 'label') = 'string'
                THEN left(t.initiator_context ->> 'label', 256)
                ELSE NULL
              END
            ))
          ELSE NULL END,
          jsonb_strip_nulls(jsonb_build_object(
            'label', CASE
              WHEN jsonb_typeof(t.initiator_context -> 'label') = 'string'
              THEN left(t.initiator_context ->> 'label', 256)
              ELSE NULL
            END,
            'backfill', CASE
              WHEN jsonb_typeof(t.initiator_context -> 'backfill') = 'boolean'
              THEN t.initiator_context -> 'backfill'
              ELSE NULL
            END,
            'attributionOmitted', CASE
              WHEN octet_length(t.initiator_subject_id) > 1024 THEN 'subject_id_too_large'
              ELSE NULL
            END
          )),
          t.source
        INTO v_initiator, v_context, v_origin
        FROM %1$I.session_turns t
        WHERE t.workspace_id = NEW.workspace_id AND t.id = NEW.turn_id;
      ELSIF NEW.type = 'session.created' THEN
        SELECT
          CASE WHEN octet_length(s.created_by_subject_id) <= 1024 THEN
            jsonb_strip_nulls(jsonb_build_object(
              'kind', s.created_by_kind,
              'subjectId', s.created_by_subject_id,
              'label', CASE
                WHEN jsonb_typeof(s.created_by_context -> 'label') = 'string'
                THEN left(s.created_by_context ->> 'label', 256)
                ELSE NULL
              END
            ))
          ELSE NULL END,
          jsonb_strip_nulls(jsonb_build_object(
            'label', CASE
              WHEN jsonb_typeof(s.created_by_context -> 'label') = 'string'
              THEN left(s.created_by_context ->> 'label', 256)
              ELSE NULL
            END,
            'backfill', CASE
              WHEN jsonb_typeof(s.created_by_context -> 'backfill') = 'boolean'
              THEN s.created_by_context -> 'backfill'
              ELSE NULL
            END,
            'attributionOmitted', CASE
              WHEN octet_length(s.created_by_subject_id) > 1024 THEN 'subject_id_too_large'
              ELSE NULL
            END
          )),
          NULL
        INTO v_initiator, v_context, v_origin
        FROM %1$I.sessions s
        WHERE s.workspace_id = NEW.workspace_id AND s.id = NEW.session_id;
      END IF;

      v_payload_bytes := octet_length(NEW.payload::text)
        + octet_length(NEW.type)
        + coalesce(octet_length(NEW.client_event_id), 0)
        + coalesce(octet_length(NEW.turn_association), 0)
        + coalesce(octet_length(NEW.duplicate_reason), 0)
        + octet_length(coalesce(v_initiator, 'null'::jsonb)::text)
        + octet_length(v_context::text)
        + 768;
      INSERT INTO %1$I.host_export_outbox (
        export_kind, source_id, account_id, workspace_id, session_id,
        turn_id, turn_generation, turn_attempt_id, session_sequence,
        client_event_id, turn_association, duplicate_of_event_id, duplicate_reason,
        event_type, idempotency_key, initiator, initiator_context, origin,
        payload, payload_codec_version, envelope_bytes, occurred_at,
        source_recorded_at, enqueued_at
      ) VALUES (
        'session_event', NEW.id, NEW.account_id, NEW.workspace_id, NEW.session_id,
        NEW.turn_id, NEW.turn_generation, NEW.turn_attempt_id, NEW.sequence,
        NEW.client_event_id, NEW.turn_association, NEW.duplicate_of_event_id,
        NEW.duplicate_reason,
        NEW.type, 'session_event:' || NEW.id::text, v_initiator,
        coalesce(v_context, '{}'::jsonb), v_origin, NEW.payload,
        NEW.payload_codec_version, greatest(1, v_payload_bytes), NEW.occurred_at,
        NEW.created_at, clock_timestamp()
      )
      ON CONFLICT (export_kind, source_id) DO NOTHING;
      RETURN NEW;
    END $function$;
  $create$, target_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.host_export_claim_sidecars(
      p_export_kind text,
      p_consumer_id text,
      p_lease_token uuid
    ) RETURNS TABLE (
      export_cursor bigint,
      root_session_id uuid,
      payload_codec_version integer
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      v_consumer %1$I.host_export_consumers%%ROWTYPE;
    BEGIN
      SELECT * INTO v_consumer
      FROM %1$I.host_export_consumers c
      WHERE c.export_kind = p_export_kind
        AND c.consumer_id = p_consumer_id
      FOR UPDATE;
      IF NOT FOUND
        OR v_consumer.lease_token IS DISTINCT FROM p_lease_token
        OR v_consumer.lease_from IS NULL
        OR v_consumer.lease_through IS NULL
        OR v_consumer.lease_expires_at IS NULL
        OR v_consumer.lease_expires_at <= now() THEN
        RAISE EXCEPTION 'host export lease is not current'
          USING ERRCODE = '55000';
      END IF;

      RETURN QUERY
      SELECT o.export_cursor, o.root_session_id, o.payload_codec_version
      FROM %1$I.host_export_outbox o
      WHERE o.export_kind = p_export_kind
        AND o.export_cursor > v_consumer.lease_from
        AND o.export_cursor <= v_consumer.lease_through
      ORDER BY o.export_cursor;
    END $function$;
  $create$, target_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.dead_letter_host_export_head(
      p_export_kind text, p_consumer_id text, p_lease_token uuid,
      p_export_cursor bigint, p_reason text
    ) RETURNS bigint
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      v_consumer %1$I.host_export_consumers%%ROWTYPE;
      v_row %1$I.host_export_outbox%%ROWTYPE;
      v_envelope jsonb;
    BEGIN
      IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION 'dead-letter reason must contain 1 to 500 characters'
          USING ERRCODE = '22023';
      END IF;
      SELECT * INTO v_consumer
      FROM %1$I.host_export_consumers c
      WHERE c.export_kind = p_export_kind AND c.consumer_id = p_consumer_id
      FOR UPDATE;
      IF NOT FOUND OR v_consumer.lease_token IS DISTINCT FROM p_lease_token
        OR v_consumer.lease_through IS NULL THEN
        RAISE EXCEPTION 'host export lease is stale' USING ERRCODE = '40001';
      END IF;
      IF p_export_cursor IS NULL OR p_export_cursor <> v_consumer.checkpoint + 1
        OR p_export_cursor > v_consumer.lease_through THEN
        RAISE EXCEPTION 'only the leased head event may be dead-lettered'
          USING ERRCODE = '22023';
      END IF;

      SELECT * INTO STRICT v_row FROM %1$I.host_export_outbox o
      WHERE o.export_kind = p_export_kind AND o.export_cursor = p_export_cursor;
      IF p_export_kind = 'session_event' THEN
        v_envelope := jsonb_build_object(
          'schemaRevision', '2026-07-host-export-v1',
          'cursor', v_row.export_cursor::text,
          'idempotencyKey', v_row.idempotency_key,
          'accountId', v_row.account_id,
          'workspaceId', v_row.workspace_id,
          'initiator', v_row.initiator,
          'initiatorContext', v_row.initiator_context,
          'origin', v_row.origin,
          'event', jsonb_strip_nulls(jsonb_build_object(
            'id', v_row.source_id,
            'workspaceId', v_row.workspace_id,
            'sessionId', v_row.session_id,
            'sequence', v_row.session_sequence,
            'type', v_row.event_type,
            'payload', v_row.payload,
            'occurredAt', v_row.occurred_at,
            'clientEventId', v_row.client_event_id,
            'turnId', v_row.turn_id,
            'turnGeneration', v_row.turn_generation,
            'turnAttemptId', v_row.turn_attempt_id,
            'turnAssociation', v_row.turn_association,
            'duplicateOfEventId', v_row.duplicate_of_event_id,
            'duplicateReason', v_row.duplicate_reason
          ))
        );
      ELSE
        v_envelope := jsonb_build_object(
          'schemaRevision', '2026-07-host-export-v1',
          'cursor', v_row.export_cursor::text,
          'accountId', v_row.account_id,
          'workspaceId', v_row.workspace_id,
          'sessionId', v_row.session_id,
          'turnId', v_row.turn_id,
          'turnAttemptId', v_row.turn_attempt_id,
          'initiator', v_row.initiator,
          'initiatorContext', v_row.initiator_context,
          'origin', v_row.origin,
          'usage', v_row.payload
        );
      END IF;

      INSERT INTO %1$I.host_export_dead_letters (
        consumer_id, export_kind, export_cursor, source_id, reason, envelope,
        envelope_codec_version, event_payload_codec_version
      ) VALUES (
        p_consumer_id, p_export_kind, p_export_cursor, v_row.source_id,
        p_reason, v_envelope, NULL,
        CASE WHEN p_export_kind = 'session_event' THEN v_row.payload_codec_version ELSE NULL END
      ) ON CONFLICT (export_kind, consumer_id, export_cursor) DO NOTHING;

      UPDATE %1$I.host_export_consumers c
      SET (
        checkpoint, lease_token, lease_holder_id, lease_expires_at,
        lease_from, lease_through, consecutive_failures, next_attempt_at,
        last_error, last_error_at, blocked_at, updated_at
      ) = (
        p_export_cursor, NULL::uuid, NULL::text, NULL::timestamptz,
        NULL::bigint, NULL::bigint, 0, now(),
        left('dead-lettered: ' || p_reason, 500), now(), NULL::timestamptz, now()
      )
      WHERE c.id = v_consumer.id;
      RETURN p_export_cursor;
    END $function$;
  $create$, target_schema);
END $migration$;

REVOKE ALL ON FUNCTION
  opengeni_private.enqueue_host_session_event_export() FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_host_export.host_export_claim_sidecars(text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_host_export.dead_letter_host_export_head(text, text, uuid, bigint, text) FROM PUBLIC;

-- Preserve existing host-configured exporter grants for the new sidecar
-- helper without guessing a role name. The published claim function remains
-- the ACL authority and is otherwise unchanged.
DO $migration$
DECLARE v_role name;
BEGIN
  FOR v_role IN
    SELECT grantee.rolname
    FROM pg_catalog.pg_proc proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
    ) privilege
    JOIN pg_catalog.pg_roles grantee ON grantee.oid = privilege.grantee
    WHERE proc.oid =
      'opengeni_host_export.claim_host_export_batch(text, text, uuid, text, integer, integer, integer)'::regprocedure
      AND privilege.grantee <> proc.proowner
      AND privilege.privilege_type = 'EXECUTE'
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_host_export.host_export_claim_sidecars(text, text, uuid) TO %I',
      v_role
    );
  END LOOP;
END $migration$;

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
COMMENT ON COLUMN host_export_outbox.payload IS
  'Original storage payload. Session-event rows carry exact codec truth in payload_codec_version; usage rows remain ordinary JSON with NULL codec version.';
COMMENT ON COLUMN host_export_outbox.payload_codec_version IS
  'Out-of-band codec truth for the complete outbox payload. NULL is literal legacy or ordinary usage JSON; 1 means the whole payload used the application lossless codec.';
COMMENT ON COLUMN host_export_dead_letters.envelope IS
  'Original mixed dead-letter envelope. SQL-built envelopes remain literal with NULL envelope_codec_version; nested session-event payload codec truth is separate.';
COMMENT ON COLUMN host_export_dead_letters.event_payload_codec_version IS
  'Out-of-band codec truth only for envelope.event.payload. It never implies that the surrounding mixed envelope is encoded.';
COMMENT ON COLUMN knowledge_memories.text IS
  'Canonical exact memory text; PostgreSQL-unsafe code units use the application text codec.';
COMMENT ON COLUMN audit_events.metadata IS
  'Canonical audit metadata; value-bearing secret audit fields remain prohibited by their domain contract.';
