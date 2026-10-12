-- deployment-mode: maintenance
-- Broker never-started settlement requires exact retained native cancellation
-- evidence, independently of the existing pristine-process/holder guards.
-- Old broker writers cannot use only a launch-rejection marker after this cutover.
-- Router rejection and all existing evidence remain unchanged; no rows are rewritten.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION opengeni_private.native_broker_launch_rejection_proven(
  process sandbox_retained_processes, proof jsonb
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $proof$
DECLARE
  descriptor jsonb := process.provider_command;
  broker uuid;
  request_hash text;
  response_hash text;
  reply_body text := '{"state":"not_started","launchClosed":true}';
BEGIN
  IF NOT ((descriptor->>'kind' = 'modal-broker-v1'
    AND jsonb_typeof(proof) = 'object'
    AND proof - ARRAY['requestId','ownerEpoch','inputSequence','responseSequence'] = '{}'::jsonb
    AND jsonb_typeof(proof->'requestId') = 'string'
    AND proof->>'requestId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND jsonb_typeof(proof->'ownerEpoch') = 'number' AND proof->>'ownerEpoch' ~ '^[1-9][0-9]*$'
    AND jsonb_typeof(proof->'inputSequence') = 'number' AND proof->>'inputSequence' ~ '^[1-9][0-9]*$'
    AND jsonb_typeof(proof->'responseSequence') = 'number' AND proof->>'responseSequence' ~ '^[1-9][0-9]*$'
  ) IS TRUE) THEN RETURN false; END IF;
  IF (proof->>'ownerEpoch')::numeric NOT BETWEEN (descriptor->'supervision'->>'launchEpoch')::numeric AND 9007199254740991
    OR (proof->>'inputSequence')::numeric NOT BETWEEN 1 AND 4294967295
    OR (proof->>'responseSequence')::numeric NOT BETWEEN 1 AND 9007199254740991
  THEN RETURN false; END IF;
  broker := (descriptor->'supervision'->>'brokerId')::uuid;
  -- Reconstruct only these fixed v1 messages, not an arbitrary frame parser.
  -- Their bytes must equal the authenticated channel's already committed
  -- request, indexed control reply and canonical output frame simultaneously.
  request_hash := encode(sha256(convert_to(concat_ws(E'\t',
    'OGB1', 'request', broker::text, proof->>'ownerEpoch', proof->>'inputSequence',
    proof->>'requestId', descriptor->>'execId', 'control', '0', '6', 'base64', 'Y2FuY2Vs'
  ) || E'\n', 'UTF8')), 'hex');
  response_hash := encode(sha256(convert_to(concat_ws(E'\t',
    'OGB1', 'response', broker::text, proof->>'ownerEpoch', proof->>'responseSequence',
    proof->>'requestId', descriptor->>'execId', 'status', '0', octet_length(reply_body)::text,
    'base64', encode(convert_to(reply_body, 'UTF8'), 'base64')
  ) || E'\n', 'UTF8')), 'hex');
  RETURN EXISTS (
    SELECT 1 FROM native_command_broker_transports t
    JOIN native_command_broker_entries request ON request.broker_id = t.id
      AND request.account_id = t.account_id AND request.workspace_id = t.workspace_id
      AND request.kind = 'request' AND request.entry_key = proof->>'requestId'
      AND request.sequence = (proof->>'inputSequence')::bigint AND request.sha256 = request_hash
    JOIN native_command_broker_entries reply ON reply.broker_id = t.id
      AND reply.account_id = t.account_id AND reply.workspace_id = t.workspace_id
      AND reply.kind = 'control_reply' AND reply.entry_key = proof->>'requestId'
      AND reply.sequence = (proof->>'responseSequence')::bigint AND reply.sha256 = response_hash
    JOIN native_command_broker_entries frame ON frame.broker_id = t.id
      AND frame.account_id = t.account_id AND frame.workspace_id = t.workspace_id
      AND frame.kind = 'frame' AND frame.entry_key = proof->>'responseSequence'
      AND frame.sequence = reply.sequence AND frame.sha256 = response_hash
    WHERE t.id = broker AND t.account_id = process.account_id AND t.workspace_id = process.workspace_id
      AND t.lease_id = process.lease_id AND t.sandbox_group_id = process.sandbox_group_id
      AND t.binding->>'sandboxId' = process.provider_instance_id
      AND t.binding->>'sandboxId' = descriptor->>'sandboxId'
      AND t.binding->>'taskId' = descriptor->>'taskId'
      AND t.binding->>'providerBindingKey' = process.provider_binding_key
      AND (t.binding->>'createEpoch')::bigint = process.lease_epoch
  );
END
$proof$;

CREATE FUNCTION opengeni_private.native_broker_launch_rejection_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $guard$
BEGIN
  IF OLD.provider_command->>'kind' = 'modal-broker-v1'
    AND OLD.state = 'active' AND NEW.state = 'lost'
    AND NEW.settlement_reason = 'provider_start_rejected'
    AND (OLD.provider_command->'capture'->>'receiptAckObserved' IS DISTINCT FROM 'false'
      OR NOT opengeni_private.native_broker_launch_rejection_proven(OLD,
        nullif(current_setting('opengeni.native_broker_launch_rejection_proof', true), '')::jsonb))
  THEN
    RAISE EXCEPTION 'Broker launch rejection requires exact committed cancellation proof' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER native_broker_launch_rejection_guard BEFORE UPDATE
  ON sandbox_retained_processes FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.native_broker_launch_rejection_guard();
COMMENT ON FUNCTION opengeni_private.native_broker_launch_rejection_guard()
  IS 'native-broker-launch-rejection-v1';
