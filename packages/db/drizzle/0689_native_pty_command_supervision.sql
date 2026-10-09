-- deployment-mode: maintenance
-- Extend initial native ownership to PTYs. Existing v1 rows and all immutable
-- receipt/output, cancellation, loss and holder fences remain unchanged.
-- No legacy row is upgraded. Drain old writers before this readiness marker
-- permits mandatory PTY launches; old contract readers cannot parse that protocol.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION opengeni_private.supervised_command_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $guard$
DECLARE
  descriptor jsonb;
  receipt jsonb;
  stream text;
  loss_binding jsonb;
  capture_lease sandbox_leases%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.provider_command ? 'supervision' AND (
      OLD.state = 'active' OR (OLD.state <> 'lost' AND (OLD.supervision_receipt IS NULL OR NOT OLD.supervision_output_captured))
    ) THEN
      RAISE EXCEPTION 'Unsettled supervised command evidence cannot be deleted' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  descriptor := NEW.provider_command->'supervision';
  IF TG_OP = 'UPDATE' THEN
    IF NEW.supervision_retention_xid IS DISTINCT FROM OLD.supervision_retention_xid THEN
      RAISE EXCEPTION 'Retention transaction identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD.provider_command ? 'supervision' AND (
      descriptor IS DISTINCT FROM OLD.provider_command->'supervision'
      OR (NEW.provider_command - 'streams') IS DISTINCT FROM (OLD.provider_command - 'streams')
      OR ROW(NEW.lease_id, NEW.lease_epoch, NEW.provider_backend, NEW.provider_instance_id,
        NEW.provider_binding_key, NEW.provider_binding, NEW.parent_admission_id, NEW.holder_id,
        NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.sandbox_group_id, NEW.id,
        NEW.provider_session_id, NEW.route_kind, NEW.route_target_id, NEW.route_epoch)
        IS DISTINCT FROM ROW(OLD.lease_id, OLD.lease_epoch, OLD.provider_backend, OLD.provider_instance_id,
        OLD.provider_binding_key, OLD.provider_binding, OLD.parent_admission_id, OLD.holder_id,
        OLD.account_id, OLD.workspace_id, OLD.session_id, OLD.sandbox_group_id, OLD.id,
        OLD.provider_session_id, OLD.route_kind, OLD.route_target_id, OLD.route_epoch)
    ) THEN
      RAISE EXCEPTION 'Supervised command identity is immutable' USING ERRCODE = '55000';
    END IF;
    -- The retainer promotes then attaches the locator in ONE transaction.
    -- Never retrofit supervision to a committed descriptor-free legacy row.
    IF descriptor IS NOT NULL AND NOT (coalesce(OLD.provider_command, '{}'::jsonb) ? 'supervision')
      AND OLD.supervision_retention_xid IS DISTINCT FROM pg_current_xact_id() THEN
      RAISE EXCEPTION 'Supervision requires initial retention' USING ERRCODE = '55000';
    END IF;
    IF OLD.cancellation_requested_at IS NOT NULL AND
      ROW(NEW.cancellation_requested_at, NEW.cancellation_reason) IS DISTINCT FROM
      ROW(OLD.cancellation_requested_at, OLD.cancellation_reason) THEN
      RAISE EXCEPTION 'Cancellation intent is monotonic' USING ERRCODE = '55000';
    END IF;
    IF OLD.supervision_receipt IS NOT NULL AND NEW.supervision_receipt IS DISTINCT FROM OLD.supervision_receipt
      OR OLD.supervision_output_captured AND NOT NEW.supervision_output_captured THEN
      RAISE EXCEPTION 'Supervision proof is immutable' USING ERRCODE = '55000';
    END IF;
    IF (OLD.cancellation_requested_at IS NOT NULL OR OLD.supervision_receipt IS NOT NULL)
      AND NEW.provider_command_input_index IS DISTINCT FROM OLD.provider_command_input_index THEN
      RAISE EXCEPTION 'Supervised stdin admission is closed' USING ERRCODE = '55000';
    END IF;
    IF descriptor IS NOT NULL AND NEW.provider_command_input_index IS DISTINCT FROM OLD.provider_command_input_index
      AND NOT EXISTS (
        SELECT 1 FROM sandbox_workspace_mutation_admissions child
        WHERE child.account_id = NEW.account_id AND child.workspace_id = NEW.workspace_id
          AND child.actor_kind = 'process' AND child.actor_id = NEW.id AND child.settled_at IS NULL
          AND child.lease_id = NEW.lease_id AND child.lease_epoch = NEW.lease_epoch
          AND child.provider_backend = NEW.provider_backend AND child.provider_instance_id = NEW.provider_instance_id
      ) THEN
      RAISE EXCEPTION 'Supervised stdin requires an unsettled child admission' USING ERRCODE = '55000';
    END IF;
    IF descriptor IS NOT NULL AND NEW.provider_command_input_index < OLD.provider_command_input_index THEN
      RAISE EXCEPTION 'Supervised stdin sequence cannot regress' USING ERRCODE = '55000';
    END IF;
    IF OLD.cancellation_requested_at IS NOT NULL AND
      ROW(NEW.owner_actor_kind, NEW.owner_actor_id, NEW.owner_turn_id, NEW.owner_attempt_id, NEW.owner_execution_generation)
      IS DISTINCT FROM ROW(OLD.owner_actor_kind, OLD.owner_actor_id, OLD.owner_turn_id, OLD.owner_attempt_id, OLD.owner_execution_generation) THEN
      RAISE EXCEPTION 'Cancelled command cannot be adopted' USING ERRCODE = '55000';
    END IF;
    IF OLD.provider_command ? 'supervision' AND OLD.state <> 'active' AND
      ROW(NEW.state, NEW.exit_code, NEW.settled_at) IS DISTINCT FROM ROW(OLD.state, OLD.exit_code, OLD.settled_at) THEN
      RAISE EXCEPTION 'Supervised terminal state is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD.provider_command ? 'supervision' THEN
      -- Old JSON writers must not skip output bytes that a newer reader would
      -- otherwise mistake for captured output. This transaction-local protocol
      -- marker is set only around captureRetainedRouterOutput's atomic event +
      -- cursor update. It is not an authentication boundary against DB owners.
      IF ((NEW.provider_command->'streams') IS DISTINCT FROM (OLD.provider_command->'streams')
        OR NEW.supervision_output_captured IS DISTINCT FROM OLD.supervision_output_captured)
        AND current_setting('opengeni.supervised_output_capture_process_id', true) IS DISTINCT FROM NEW.id::text THEN
        RAISE EXCEPTION 'Supervised output requires atomic capture protocol' USING ERRCODE = '55000';
      END IF;
      FOREACH stream IN ARRAY ARRAY['stdout', 'stderr'] LOOP
        IF (NEW.provider_command->'streams'->stream->>'byteOffset')::bigint <
             (OLD.provider_command->'streams'->stream->>'byteOffset')::bigint
          OR (OLD.provider_command->'streams'->stream->>'eof')::boolean AND
            ((NEW.provider_command->'streams'->stream) - 'exitCode') IS DISTINCT FROM ((OLD.provider_command->'streams'->stream) - 'exitCode')
          OR OLD.provider_command->'streams'->stream->>'exitCode' IS NOT NULL AND
            NEW.provider_command->'streams'->stream IS DISTINCT FROM OLD.provider_command->'streams'->stream THEN
          RAISE EXCEPTION 'Supervised output proof cannot regress' USING ERRCODE = '55000';
        END IF;
      END LOOP;
    END IF;
  END IF;
  IF (NEW.cancellation_requested_at IS NULL) <> (NEW.cancellation_reason IS NULL)
    OR NEW.cancellation_reason IS NOT NULL AND NEW.cancellation_reason NOT IN ('provider_deadline', 'explicit_stop') THEN
    RAISE EXCEPTION 'Invalid cancellation intent' USING ERRCODE = '23514';
  END IF;
  IF descriptor IS NULL THEN
    IF NEW.supervision_receipt IS NOT NULL OR NEW.supervision_output_captured THEN
      RAISE EXCEPTION 'Legacy command cannot acquire supervision proof' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Initial attachment and capture serialize on the lease. A committed legacy
  -- row cannot be upgraded (above); an in-flight initial attachment must not
  -- appear after an older worker has already admitted capture/containment.
  IF TG_OP = 'INSERT' OR NOT (coalesce(OLD.provider_command, '{}'::jsonb) ? 'supervision') THEN
    SELECT * INTO capture_lease FROM sandbox_leases WHERE id = NEW.lease_id FOR UPDATE;
    IF capture_lease.archive_capture_id IS NOT NULL OR capture_lease.unobservable_command_drain_ids IS NOT NULL THEN
      RAISE EXCEPTION 'Supervised launch cannot join checkpoint containment' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NOT ((jsonb_typeof(descriptor) = 'object'
    AND NEW.provider_command->>'kind' = 'modal-router-v1'
    AND ((descriptor->>'protocol' = 'native-subreaper-v1'
          AND NOT coalesce((NEW.provider_command->>'pty')::boolean, false))
      OR (descriptor->>'protocol' = 'native-subreaper-pty-v1'
          AND coalesce((NEW.provider_command->>'pty')::boolean, false)))
    AND descriptor->>'invocationId' ~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'
    AND descriptor->>'nonce' ~ '^[0-9a-f]{64}$'
    AND descriptor->>'controlPath' ~ '^/tmp/opengeni-supervision/[a-f0-9-]{36}\.sock$'
    AND descriptor - ARRAY['protocol', 'invocationId', 'nonce', 'controlPath'] = '{}'::jsonb) IS TRUE) THEN
    RAISE EXCEPTION 'Invalid supervision descriptor' USING ERRCODE = '23514';
  END IF;
  receipt := NEW.supervision_receipt;
  IF receipt IS NOT NULL AND NOT ((jsonb_typeof(receipt) = 'object'
    AND receipt->>'protocol' = descriptor->>'protocol'
    AND receipt->>'invocationId' = descriptor->>'invocationId'
    AND receipt->>'receiptId' ~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'
    AND jsonb_typeof(receipt->'leaderExitCode') = 'number'
    AND receipt->>'leaderExitCode' ~ '^-?[0-9]+$'
    AND (receipt->>'leaderExitCode')::numeric BETWEEN -2147483648 AND 2147483647
    AND receipt - ARRAY['protocol', 'invocationId', 'receiptId', 'leaderExitCode'] = '{}'::jsonb) IS TRUE) THEN
    RAISE EXCEPTION 'Invalid invocation-bound supervision receipt' USING ERRCODE = '23514';
  END IF;
  IF NEW.supervision_output_captured AND NOT ((
    NEW.provider_command->'streams'->'stdout'->>'eof' = 'true'
    AND NEW.provider_command->'streams'->'stderr'->>'eof' = 'true'
    AND NEW.provider_command->'streams'->'stdout'->>'utf8Remainder' = ''
    AND NEW.provider_command->'streams'->'stderr'->>'utf8Remainder' = ''
    -- Zero is the supervisor's successful durable-receipt ACK exit. The user
    -- shell result is independent and remains receipt.leaderExitCode.
    AND NEW.provider_command->'streams'->'stdout'->>'exitCode' = '0'
    AND NEW.provider_command->'streams'->'stderr'->>'exitCode' = '0'
  ) IS TRUE) THEN
    RAISE EXCEPTION 'Supervised output capture is incomplete' USING ERRCODE = '55000';
  END IF;
  IF NEW.state = 'lost' THEN
    -- Missing provider is a distinct terminal truth, never successful tree
    -- quiescence. The typed loss seam locks blockers then the exact lease and
    -- opens this marker only after revalidating the original physical binding.
    -- A deferred trigger below ALSO requires the loss-bearing cold successor
    -- at commit, so merely forging a GUC cannot drop a live provider's blockers.
    IF TG_OP <> 'UPDATE' OR NEW.exit_code IS NOT NULL OR NEW.settled_at IS NULL
      OR ROW(NEW.provider_command, NEW.supervision_receipt, NEW.supervision_output_captured,
             NEW.provider_command_input_index)
         IS DISTINCT FROM ROW(OLD.provider_command, OLD.supervision_receipt, OLD.supervision_output_captured,
             OLD.provider_command_input_index) THEN
      RAISE EXCEPTION 'Supervised loss cannot fabricate execution or output proof' USING ERRCODE = '55000';
    END IF;
    IF NEW.settlement_reason = 'provider_start_rejected' THEN
      -- A distinct authenticated "never started" response licenses only an
      -- untouched retained launch, not a missing provider or failed supervisor.
      loss_binding := nullif(current_setting('opengeni.supervised_launch_rejection_binding', true), '')::jsonb;
      IF NEW.supervision_receipt IS NOT NULL OR NEW.supervision_output_captured
        OR NEW.provider_command_input_index <> 0 OR NEW.reconcile_proof_outcome IS NOT NULL
        OR NEW.provider_command->'streams' IS DISTINCT FROM
          '{"stdout":{"byteOffset":0,"utf8Remainder":"","eof":false,"exitCode":null},"stderr":{"byteOffset":0,"utf8Remainder":"","eof":false,"exitCode":null}}'::jsonb
        OR EXISTS (SELECT 1 FROM sandbox_workspace_mutation_admissions child
          WHERE child.account_id=NEW.account_id AND child.workspace_id=NEW.workspace_id
            AND child.actor_kind='process' AND child.actor_id=NEW.id)
        OR (OLD.state = 'lost' AND OLD.settlement_reason IS DISTINCT FROM NEW.settlement_reason)
        OR (OLD.state <> 'lost' AND (OLD.state <> 'active' OR loss_binding IS DISTINCT FROM
          jsonb_build_object('processId', OLD.id, 'command', OLD.provider_command))) THEN
        RAISE EXCEPTION 'Supervised launch rejection requires an exact pristine invocation' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END IF;
    loss_binding := nullif(current_setting('opengeni.supervised_provider_loss_binding', true), '')::jsonb;
    IF NEW.settlement_reason IS DISTINCT FROM 'provider_instance_lost'
      OR (OLD.state = 'lost' AND OLD.settlement_reason IS DISTINCT FROM NEW.settlement_reason)
      OR (OLD.state <> 'lost' AND (
        OLD.state <> 'active' OR loss_binding IS DISTINCT FROM jsonb_build_object(
          'accountId', OLD.account_id, 'workspaceId', OLD.workspace_id,
          'leaseId', OLD.lease_id, 'sandboxGroupId', OLD.sandbox_group_id,
          'lostEpoch', OLD.lease_epoch, 'lostBackend', OLD.provider_backend,
          'lostInstanceId', OLD.provider_instance_id
        )
      )) THEN
      RAISE EXCEPTION 'Supervised loss requires the exact typed provider-loss transition' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF receipt IS NOT NULL AND EXISTS (
    SELECT 1 FROM sandbox_workspace_mutation_admissions child
    WHERE child.account_id = NEW.account_id AND child.workspace_id = NEW.workspace_id
      AND child.actor_kind = 'process' AND child.actor_id = NEW.id AND child.settled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Admitted command input must settle before quiescence' USING ERRCODE = '55000';
  END IF;
  IF NEW.state <> 'active' OR NEW.settled_at IS NOT NULL THEN
    IF NOT ((NEW.state = 'exited' AND receipt IS NOT NULL
      AND NEW.supervision_output_captured
      AND NEW.exit_code = (receipt->>'leaderExitCode')::integer
    ) IS TRUE) THEN
      RAISE EXCEPTION 'Supervised settlement requires quiescence, provider terminal and captured output' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$guard$;

-- Protocol-specific readiness must distinguish this definition from 0496's
-- five identically named triggers, which intentionally reject PTY descriptors.
COMMENT ON FUNCTION opengeni_private.supervised_command_guard()
  IS 'native-subreaper-pty-v1';
