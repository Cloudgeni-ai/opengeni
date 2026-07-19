-- deployment-mode: rolling
-- OPE-64: session_events is the lossy human/audit projection, not a blob store.
-- Install the BEFORE trigger before the NOT VALID check so an older pod in the
-- same rolling deployment is normalized instead of having an oversized write
-- rejected. Historical oversized rows stay readable and can be defensively
-- bounded by NATS/SSE; NOT VALID enforces the invariant for every new row.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE OR REPLACE FUNCTION opengeni_private.project_session_event_payload(source_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
DECLARE
  original_bytes integer;
  delivered_bytes integer;
  bounded jsonb;
BEGIN
  original_bytes := octet_length(source_payload::text);
  IF original_bytes <= 65536 THEN
    RETURN source_payload;
  END IF;

  -- This is intentionally a small content-free fallback. Normal application
  -- writers produce richer deterministic head/tail previews before INSERT; the
  -- trigger exists for rolling old binaries and unforeseen direct writers.
  bounded := jsonb_strip_nulls(jsonb_build_object(
    'id', left(source_payload ->> 'id', 256),
    'name', left(coalesce(source_payload ->> 'name', source_payload ->> 'toolName'), 256),
    'type', left(source_payload ->> 'type', 128),
    'status', left(source_payload ->> 'status', 128),
    'code', left(source_payload ->> 'code', 128),
    'isError', source_payload -> 'isError',
    'preview', '[event payload omitted by durable audit storage guard]',
    'truncation', jsonb_build_object(
      'truncated', true,
      'surface', 'database_guard',
      'reason', 'database_guard',
      'originalBytes', original_bytes,
      'deliveredBytes', 0,
      'omittedBytes', original_bytes,
      'estimatedOriginalTokens', ceil(original_bytes / 4.0)::integer,
      'estimatedDeliveredTokens', 0,
      'fullEvidence', jsonb_build_object('available', false, 'reason', 'not_retained'),
      'details', jsonb_build_array(jsonb_build_object(
        'path', '$',
        'kind', 'object',
        'originalBytes', original_bytes
      ))
    )
  ));

  -- Size fields affect their own JSON width. Converge to an exact fixed point
  -- without retaining any omitted content; fail the write rather than publish
  -- false accounting if PostgreSQL's representation ever stops converging.
  FOR pass IN 1..8 LOOP
    delivered_bytes := octet_length(bounded::text);
    EXIT WHEN (bounded #>> '{truncation,deliveredBytes}')::integer = delivered_bytes
      AND (bounded #>> '{truncation,omittedBytes}')::integer
        = greatest(0, original_bytes - delivered_bytes)
      AND (bounded #>> '{truncation,estimatedDeliveredTokens}')::integer
        = ceil(delivered_bytes / 4.0)::integer;
    bounded := jsonb_set(bounded, '{truncation,deliveredBytes}', to_jsonb(delivered_bytes), false);
    bounded := jsonb_set(
      bounded,
      '{truncation,omittedBytes}',
      to_jsonb(greatest(0, original_bytes - delivered_bytes)),
      false
    );
    bounded := jsonb_set(
      bounded,
      '{truncation,estimatedDeliveredTokens}',
      to_jsonb(ceil(delivered_bytes / 4.0)::integer),
      false
    );
  END LOOP;

  delivered_bytes := octet_length(bounded::text);
  IF (bounded #>> '{truncation,deliveredBytes}')::integer <> delivered_bytes
    OR (bounded #>> '{truncation,omittedBytes}')::integer
      <> greatest(0, original_bytes - delivered_bytes)
    OR (bounded #>> '{truncation,estimatedDeliveredTokens}')::integer
      <> ceil(delivered_bytes / 4.0)::integer THEN
    RAISE EXCEPTION 'session event payload accounting failed to converge';
  END IF;

  RETURN bounded;
END;
$function$;

CREATE OR REPLACE FUNCTION opengeni_private.bound_session_event_payload()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  original_type text := NEW.type;
  original_event_bytes integer;
  fields jsonb := '[]'::jsonb;
  delivered text;
BEGIN
  original_event_bytes := octet_length(row_to_json(NEW)::text);
  -- Bound every free-form envelope string by UTF-8 bytes. left() uses
  -- characters, so one quarter of each byte limit is a conservative bound for
  -- both ASCII and four-byte Unicode without ever splitting a code point.
  IF octet_length(NEW.type) > 256 OR position(E'\n' in NEW.type) > 0
    OR position(E'\r' in NEW.type) > 0 THEN
    delivered := 'session.event.envelope_omitted';
    fields := fields || jsonb_build_array(jsonb_build_object(
      'field', 'type',
      'originalBytes', octet_length(NEW.type),
      'deliveredBytes', octet_length(delivered)
    ));
    NEW.type := delivered;
  END IF;

  IF NEW.client_event_id IS NOT NULL AND octet_length(NEW.client_event_id) > 1024 THEN
    delivered := left(NEW.client_event_id, 256);
    fields := fields || jsonb_build_array(jsonb_build_object(
      'field', 'clientEventId',
      'originalBytes', octet_length(NEW.client_event_id),
      'deliveredBytes', octet_length(delivered)
    ));
    NEW.client_event_id := delivered;
  END IF;

  IF NEW.producer_id IS NOT NULL AND octet_length(NEW.producer_id) > 1024 THEN
    delivered := left(NEW.producer_id, 256);
    fields := fields || jsonb_build_array(jsonb_build_object(
      'field', 'producerId',
      'originalBytes', octet_length(NEW.producer_id),
      'deliveredBytes', octet_length(delivered)
    ));
    NEW.producer_id := delivered;
  END IF;

  IF NEW.turn_association IS NOT NULL AND NEW.turn_association NOT IN (
    'current', 'late_rejected', 'duplicate'
  ) THEN
    fields := fields || jsonb_build_array(jsonb_build_object(
      'field', 'turnAssociation',
      'originalBytes', octet_length(NEW.turn_association),
      'deliveredBytes', 0
    ));
    NEW.turn_association := NULL;
  END IF;

  IF NEW.duplicate_reason IS NOT NULL AND octet_length(NEW.duplicate_reason) > 4096 THEN
    delivered := left(NEW.duplicate_reason, 1024);
    fields := fields || jsonb_build_array(jsonb_build_object(
      'field', 'duplicateReason',
      'originalBytes', octet_length(NEW.duplicate_reason),
      'deliveredBytes', octet_length(delivered)
    ));
    NEW.duplicate_reason := delivered;
  END IF;

  IF jsonb_array_length(fields) > 0 THEN
    NEW.payload := jsonb_build_object(
      'preview', '[legacy event envelope normalized by durable audit storage guard]',
      'originalEventBytes', original_event_bytes,
      'originalType', left(original_type, 64),
      'envelopeProjection', jsonb_build_object(
        'truncated', true,
        'surface', 'database_guard',
        'fields', fields
      ),
      'fullEvidence', jsonb_build_object('available', false, 'reason', 'not_retained')
    );
  END IF;

  NEW.payload := opengeni_private.project_session_event_payload(NEW.payload);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS session_events_bound_payload_before_insert ON session_events;
CREATE TRIGGER session_events_bound_payload_before_insert
BEFORE INSERT OR UPDATE OF payload, type, client_event_id, producer_id, turn_association, duplicate_reason
ON session_events
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.bound_session_event_payload();

ALTER TABLE session_events
  ADD CONSTRAINT session_events_payload_bytes_check
  CHECK (octet_length(payload::text) <= 65536)
  NOT VALID,
  ADD CONSTRAINT session_events_type_bytes_check
  CHECK (
    octet_length(type) <= 256
    AND position(E'\n' in type) = 0
    AND position(E'\r' in type) = 0
  )
  NOT VALID,
  ADD CONSTRAINT session_events_client_event_id_bytes_check
  CHECK (client_event_id IS NULL OR octet_length(client_event_id) <= 1024)
  NOT VALID,
  ADD CONSTRAINT session_events_producer_id_bytes_check
  CHECK (producer_id IS NULL OR octet_length(producer_id) <= 1024)
  NOT VALID,
  ADD CONSTRAINT session_events_turn_association_bytes_check
  CHECK (turn_association IS NULL OR octet_length(turn_association) <= 64)
  NOT VALID,
  ADD CONSTRAINT session_events_duplicate_reason_bytes_check
  CHECK (duplicate_reason IS NULL OR octet_length(duplicate_reason) <= 4096)
  NOT VALID;