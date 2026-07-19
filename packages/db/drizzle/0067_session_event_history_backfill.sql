-- deployment-mode: rolling
-- OPE-64: finish the 0065 expand/contract sequence. The trigger has bounded
-- every new/updated row since 0065; now rewrite only legacy violations through
-- that trigger and validate the durable storage invariant.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

UPDATE session_events
SET
  payload = payload,
  type = type,
  client_event_id = client_event_id,
  producer_id = producer_id,
  turn_association = turn_association,
  duplicate_reason = duplicate_reason
WHERE octet_length(payload::text) > 65536
  OR octet_length(type) > 256
  OR position(E'\n' in type) > 0
  OR position(E'\r' in type) > 0
  OR (client_event_id IS NOT NULL AND octet_length(client_event_id) > 1024)
  OR (producer_id IS NOT NULL AND octet_length(producer_id) > 1024)
  OR (turn_association IS NOT NULL AND octet_length(turn_association) > 64)
  OR (duplicate_reason IS NOT NULL AND octet_length(duplicate_reason) > 4096);

ALTER TABLE session_events
  VALIDATE CONSTRAINT session_events_payload_bytes_check,
  VALIDATE CONSTRAINT session_events_type_bytes_check,
  VALIDATE CONSTRAINT session_events_client_event_id_bytes_check,
  VALIDATE CONSTRAINT session_events_producer_id_bytes_check,
  VALIDATE CONSTRAINT session_events_turn_association_bytes_check,
  VALIDATE CONSTRAINT session_events_duplicate_reason_bytes_check;