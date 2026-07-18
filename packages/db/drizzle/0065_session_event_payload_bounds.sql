-- deployment-mode: rolling
-- OPE-64: session_events is the lossy human/audit projection, not a blob store.
-- Install the BEFORE trigger before the NOT VALID check so an older pod in the
-- same rolling deployment is normalized instead of having an oversized write
-- rejected. Historical oversized rows stay readable and can be defensively
-- bounded by NATS/SSE; NOT VALID enforces the invariant for every new row.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE OR REPLACE FUNCTION opengeni_private.bound_session_event_payload()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  original_bytes integer;
  delivered_bytes integer;
  bounded jsonb;
BEGIN
  original_bytes := octet_length(NEW.payload::text);
  IF original_bytes <= 65536 THEN
    RETURN NEW;
  END IF;

  -- This is intentionally a small content-free fallback. Normal application
  -- writers produce richer deterministic head/tail previews before INSERT; the
  -- trigger exists for rolling old binaries and unforeseen direct writers.
  bounded := jsonb_strip_nulls(jsonb_build_object(
    'id', left(NEW.payload ->> 'id', 256),
    'name', left(coalesce(NEW.payload ->> 'name', NEW.payload ->> 'toolName'), 256),
    'type', left(NEW.payload ->> 'type', 128),
    'status', left(NEW.payload ->> 'status', 128),
    'code', left(NEW.payload ->> 'code', 128),
    'isError', NEW.payload -> 'isError',
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

  NEW.payload := bounded;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS session_events_bound_payload_before_insert ON session_events;
CREATE TRIGGER session_events_bound_payload_before_insert
BEFORE INSERT OR UPDATE OF payload ON session_events
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.bound_session_event_payload();

ALTER TABLE session_events
  ADD CONSTRAINT session_events_payload_bytes_check
  CHECK (octet_length(payload::text) <= 65536)
  NOT VALID;