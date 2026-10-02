-- deployment-mode: maintenance
-- The backfill reads authoritative history while all application writers are
-- stopped. Older binaries remain compatible: the statement trigger maintains
-- both cursor frontiers independently of application code.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' OR jsonb_array_length(roles) NOT BETWEEN 1 AND 16
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}') OR octet_length(item #>> '{}') > 63)
    OR EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
      WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION 'attention cursor migration requires stopped application roles' USING ERRCODE = '55000';
  END IF;
END $drain$;

ALTER TABLE session_event_cursors ADD COLUMN last_meaningful_sequence integer NOT NULL DEFAULT 0;
-- Owner-only maintenance access. Runtime FORCE RLS is restored in this same
-- transaction before either the new projection or its trigger can be visible.
ALTER TABLE session_event_cursors NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_events NO FORCE ROW LEVEL SECURITY;
UPDATE session_event_cursors cursor SET last_meaningful_sequence = coalesce((
  SELECT event.sequence FROM session_events event
  WHERE event.workspace_id = cursor.workspace_id AND event.session_id = cursor.session_id
    AND "event".type in ('agent.message.completed', 'turn.completed', 'turn.failed', 'session.requiresAction', 'session.humanInput.requested', 'tool.auth_needed', 'credential.auth_needed', 'goal.completed', 'goal.paused', 'goal.progress', 'goal.rewrite.proposed', 'rig.setup.failed', 'sandbox.operation.failed', 'sandbox.box.lost', 'workspace.revision.degraded', 'machine.op.failed', 'machine.link.lost', 'session.event.envelope_omitted')
    and "event".duplicate_of_event_id is null
    and ("event".turn_association is null or "event".turn_association = 'current')
    and ("event".type <> 'agent.message.completed' or coalesce("event".payload ->> 'text', '') <> '')
    and ("event".type <> 'agent.message.completed' or coalesce("event".payload ->> 'phase', '') <> 'commentary')
    and ("event".type <> 'turn.completed' or (
      not ("event".payload ?| array['maintenance', 'segmentLimit'])
      and ((
        coalesce(nullif("event".payload -> 'output', 'null'::jsonb), "event".payload -> 'result') is not null
        and coalesce(nullif("event".payload -> 'output', 'null'::jsonb), "event".payload -> 'result') not in ('null'::jsonb, '""'::jsonb)
      ) or coalesce("event".payload ->> 'reply', '') <> '')
    ))
  ORDER BY event.sequence DESC LIMIT 1
), 0);
ALTER TABLE session_events FORCE ROW LEVEL SECURITY;
ALTER TABLE session_event_cursors FORCE ROW LEVEL SECURITY;
ALTER TABLE session_event_cursors ADD CONSTRAINT session_event_cursors_meaningful_sequence_check
  CHECK (last_meaningful_sequence >= 0 AND last_meaningful_sequence <= last_sequence);

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
    and ("event".type <> 'turn.completed' or (
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
COMMENT ON COLUMN session_event_cursors.last_meaningful_sequence IS
  'Exact newest conversational output or actionable boundary. Backfilled from the meaningful attention index and advanced atomically with the raw append cursor.';
