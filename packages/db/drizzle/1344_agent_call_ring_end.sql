-- deployment-mode: rolling
-- Stop a call's ring on the other phones once someone answers or declines it,
-- or the agent cancels it (docs/design/agent-calls.md).
--
-- opengeni_private.end_agent_call_rings_v1(call) runs in the settled call's
-- workspace RLS context, after the call left `ringing` as answered, declined
-- or cancelled. A ring not yet sent is withdrawn, so no phone rings for a call
-- that is already over. An Android phone whose ring was sent, or is being sent,
-- gets one `ended` push (dedupe `call-ended:<call>`) carrying the outcome and
-- the call's ring deadline: the dispatcher drops it once the ring is over.
-- iOS needs no push: CallKit hears the outcome from the app itself. Returns
-- how many ended pushes were queued.
--
-- As 0937, 0978 and 1060 explain, the previous release rejects a runtime
-- EXECUTE grant on a definer it doesn't know, so this migration grants
-- nothing. Until a later migration grants it, settling a call queues nothing
-- and the other phones ring out, as before; by then the previous release's
-- dispatcher already knows the ended push.
SET LOCAL lock_timeout = '5s';

DO $agent_call_ring_end$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.end_agent_call_rings_v1(p_call_id uuid)
    RETURNS integer
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      v_call record;
      v_count integer;
    BEGIN
      SELECT call.id, call.workspace_id, call.session_id, call.callee_subject_id, call.state,
          call.ring_until
        INTO v_call
      FROM agent_calls call
      WHERE call.id = p_call_id
        AND call.state IN ('answered', 'declined', 'cancelled')
        AND call.account_id = opengeni_private.current_account_id()
        AND call.workspace_id = opengeni_private.current_workspace_id();
      IF NOT FOUND THEN
        RETURN 0;
      END IF;
      -- The callee's phones lead, so each ring is found by its unique
      -- (auth_session_id, dedupe_key) key.
      UPDATE opengeni_private.native_push_deliveries delivery SET
        failed_at = pg_catalog.now(),
        last_error = 'The call was ' || v_call.state || ' before its ring was sent'
      FROM opengeni_private.native_push_devices device
      WHERE device.subject_id = v_call.callee_subject_id
        AND delivery.auth_session_id = device.auth_session_id
        AND delivery.dedupe_key = 'call:' || v_call.id::text
        AND delivery.delivered_at IS NULL AND delivery.failed_at IS NULL
        AND (delivery.claimed_until IS NULL OR delivery.claimed_until < pg_catalog.now());
      INSERT INTO opengeni_private.native_push_deliveries
        (auth_session_id, dedupe_key, rule, payload)
      SELECT ring.auth_session_id, 'call-ended:' || v_call.id::text, 'call',
        pg_catalog.jsonb_build_object(
          'rule', 'call',
          'callId', v_call.id,
          'sessionId', v_call.session_id,
          'workspaceId', v_call.workspace_id,
          'subjectId', device.subject_id,
          'callEnded', CASE v_call.state
            WHEN 'answered' THEN 'answeredElsewhere'
            WHEN 'declined' THEN 'declinedElsewhere'
            ELSE 'remoteEnded'
          END,
          'ringUntil', pg_catalog.to_char(
            v_call.ring_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
        )
      FROM opengeni_private.native_push_devices device
      JOIN opengeni_private.native_push_deliveries ring
        ON ring.auth_session_id = device.auth_session_id
        AND ring.dedupe_key = 'call:' || v_call.id::text
      WHERE device.subject_id = v_call.callee_subject_id
        AND device.platform = 'android'
        AND ring.failed_at IS NULL
      ON CONFLICT (auth_session_id, dedupe_key) DO NOTHING;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      RETURN v_count;
    END
    $body$
  $definition$, data_schema);
END
$agent_call_ring_end$;

REVOKE ALL ON FUNCTION opengeni_private.end_agent_call_rings_v1(uuid) FROM PUBLIC;
