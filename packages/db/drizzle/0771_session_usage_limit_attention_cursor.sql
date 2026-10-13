-- deployment-mode: rolling
-- A turn stopped because its task reached its usage limit is an
-- actionable boundary: only a person can raise or clear the limit. Count it in
-- the attention frontier exactly like the 0770 partial-index predicate, so the
-- rail and session tree show it as unread without any explanatory model call.
-- No backfill: no such stop exists before this release produces one, and the
-- cursor only advances (greatest) so older binaries remain compatible.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION advance_session_event_cursors_for_inserted_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $advance_session_event_cursors$
DECLARE
  fenced_access_capability_id uuid;
  inserted_group record;
  current_sequence integer;
BEGIN
  PERFORM pg_catalog.set_config(
    'opengeni.session_variable_set_attachments_v1',
    '1',
    true
  );
  fenced_access_capability_id :=
    opengeni_private.open_session_tenancy_fenced_access(
      session_tenancy_fence_target_schema()
    );
  FOR inserted_group IN
    SELECT
      account_id,
      workspace_id,
      session_id,
      MIN(sequence)::integer AS first_sequence,
      MAX(sequence)::integer AS last_sequence,
      MAX(sequence) FILTER (WHERE "event".type in ('agent.message.completed', 'turn.completed', 'turn.failed', 'session.requiresAction', 'session.humanInput.requested', 'tool.auth_needed', 'credential.auth_needed', 'goal.completed', 'goal.paused', 'goal.progress', 'goal.rewrite.proposed', 'rig.setup.failed', 'sandbox.operation.failed', 'sandbox.box.lost', 'workspace.revision.degraded', 'machine.op.failed', 'machine.link.lost', 'session.event.envelope_omitted')
    and "event".duplicate_of_event_id is null
    and ("event".turn_association is null or "event".turn_association = 'current')
    and ("event".type <> 'agent.message.completed' or coalesce("event".payload ->> 'text', '') <> '')
    and ("event".type <> 'agent.message.completed' or coalesce("event".payload ->> 'phase', '') <> 'commentary')
    and ("event".type <> 'turn.completed' or ("event".payload ->> 'segmentLimit') = 'session_usage_limit' or (
      not ("event".payload ?| array['maintenance', 'segmentLimit'])
      and ((
        coalesce(nullif("event".payload -> 'output', 'null'::jsonb), "event".payload -> 'result') is not null
        and coalesce(nullif("event".payload -> 'output', 'null'::jsonb), "event".payload -> 'result') not in ('null'::jsonb, '""'::jsonb)
      ) or coalesce("event".payload ->> 'reply', '') <> '')
    )))::integer AS last_meaningful_sequence,
      COUNT(*)::integer AS sequence_count,
      COUNT(DISTINCT sequence)::integer AS distinct_sequence_count,
      BOOL_OR(type NOT IN (
        'agent.message.delta',
        'agent.reasoning.delta',
        'sandbox.command.output.delta',
        'terminal.pty.output.delta'
      )) AS advances_activity
    FROM inserted_session_events event
    GROUP BY account_id, workspace_id, session_id
    ORDER BY workspace_id, session_id
  LOOP
    SELECT last_sequence
    INTO current_sequence
    FROM session_event_cursors
    WHERE account_id = inserted_group.account_id
      AND workspace_id = inserted_group.workspace_id
      AND session_id = inserted_group.session_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'session event cursor is missing for an inserted event';
    END IF;
    IF inserted_group.distinct_sequence_count <> inserted_group.sequence_count
      OR inserted_group.first_sequence <> current_sequence + 1
      OR inserted_group.last_sequence <> current_sequence + inserted_group.sequence_count
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'session event insert does not exactly continue the durable cursor',
        DETAIL = pg_catalog.format(
          'workspace_id=%s session_id=%s current=%s first=%s last=%s count=%s distinct=%s',
          inserted_group.workspace_id,
          inserted_group.session_id,
          current_sequence,
          inserted_group.first_sequence,
          inserted_group.last_sequence,
          inserted_group.sequence_count,
          inserted_group.distinct_sequence_count
        );
    END IF;

    UPDATE session_event_cursors
    SET last_sequence = inserted_group.last_sequence,
        last_meaningful_sequence = greatest(last_meaningful_sequence, coalesce(inserted_group.last_meaningful_sequence, 0)),
        revision = revision + 1,
        updated_at = pg_catalog.now()
    WHERE account_id = inserted_group.account_id
      AND workspace_id = inserted_group.workspace_id
      AND session_id = inserted_group.session_id
      AND last_sequence = current_sequence;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'session event cursor changed while applying an inserted event statement';
    END IF;

    -- The wide column remains a semantic compatibility projection only. Raw
    -- batches leave it untouched; semantic SQL functions and old binaries are
    -- synchronized here even when they started from a stale projection.
    IF inserted_group.advances_activity THEN
      UPDATE sessions session
      SET last_sequence = inserted_group.last_sequence
      WHERE session.account_id = inserted_group.account_id
        AND session.workspace_id = inserted_group.workspace_id
        AND session.id = inserted_group.session_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'session projection is missing for an inserted semantic event';
      END IF;
    END IF;
  END LOOP;
  PERFORM opengeni_private.close_session_tenancy_fenced_access(
    fenced_access_capability_id
  );
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  IF fenced_access_capability_id IS NOT NULL THEN
    PERFORM opengeni_private.close_session_tenancy_fenced_access(
      fenced_access_capability_id
    );
  END IF;
  RAISE;
END
$advance_session_event_cursors$;

REVOKE ALL ON FUNCTION advance_session_event_cursors_for_inserted_events() FROM PUBLIC;
DO $safe_path$
BEGIN
  EXECUTE format('ALTER FUNCTION advance_session_event_cursors_for_inserted_events() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $safe_path$;
