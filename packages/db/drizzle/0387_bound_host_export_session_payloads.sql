-- deployment-mode: rolling
-- Host export is an optional bounded projection. Canonical session_events keeps
-- the complete lossless payload; an oversized projection must never roll back
-- the source event or a later lifecycle transaction that closes pending work.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

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
      v_source_payload_bytes integer;
      v_export_payload jsonb;
      v_export_payload_codec_version smallint;
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

      v_source_payload_bytes := octet_length(NEW.payload::text);
      v_export_payload := NEW.payload;
      v_export_payload_codec_version := NEW.payload_codec_version;
      IF v_source_payload_bytes > 65536 THEN
        v_export_payload := jsonb_build_object(
          '_hostExport', jsonb_build_object(
            'payloadMode', 'summary',
            'payloadTruncated', true,
            'originalBytes', v_source_payload_bytes,
            'sourceEventId', NEW.id,
            'fullPayload', 'retained in canonical session event'
          ),
          'preview', '[host-export payload omitted at bounded projection boundary]'
        );
        -- The projection is literal PostgreSQL JSON, not an application-codec
        -- envelope. Preserve codec truth only when the original payload is kept.
        v_export_payload_codec_version := NULL;
      END IF;

      v_payload_bytes := octet_length(v_export_payload::text)
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
        coalesce(v_context, '{}'::jsonb), v_origin, v_export_payload,
        v_export_payload_codec_version, greatest(1, v_payload_bytes), NEW.occurred_at,
        NEW.created_at, clock_timestamp()
      )
      ON CONFLICT (export_kind, source_id) DO NOTHING;
      RETURN NEW;
    END $function$;
  $create$, target_schema);
END
$migration$;

COMMENT ON COLUMN host_export_outbox.payload IS
  'Immutable bounded host projection. Canonical session_events retains the complete payload; oversized host projections carry an explicit content-free truncation receipt.';
COMMENT ON COLUMN host_export_outbox.payload_codec_version IS
  'Codec truth for the stored host projection. NULL means literal SQL JSON, including oversized-payload projections; 1 means the original application-coded payload was retained exactly.';
