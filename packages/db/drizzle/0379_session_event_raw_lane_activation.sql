-- deployment-mode: maintenance
-- Activate the cursor-authoritative raw lane only after the fleet has drained:
-- public readers move to session_event_cursors in the same release, while old
-- SQL writers remain safe through the database boundary below.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $session_event_raw_lane_writer_drain_before_lock$
DECLARE
  configured_roles_text text := nullif(
    current_setting('opengeni.migration_application_roles', true), ''
  );
  configured_roles jsonb;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION
      '0379 session event raw-lane activation requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0379 session event raw-lane activation received a malformed application database role list'
      USING ERRCODE = '55000';
  END;
  IF jsonb_typeof(configured_roles) <> 'array'
    OR jsonb_array_length(configured_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(configured_roles) AS roles(value)
      WHERE jsonb_typeof(value) <> 'string'
        OR btrim(value #>> '{}') = ''
        OR octet_length(value #>> '{}') > 63
    )
    OR (
      SELECT count(*) FROM jsonb_array_elements_text(configured_roles)
    ) <> (
      SELECT count(DISTINCT value)
      FROM jsonb_array_elements_text(configured_roles) AS roles(value)
    )
  THEN
    RAISE EXCEPTION
      '0379 session event raw-lane activation received an invalid application database role list'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0379 session event raw-lane activation requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$session_event_raw_lane_writer_drain_before_lock$;

LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE session_event_cursors IN ACCESS EXCLUSIVE MODE;
LOCK TABLE session_events IN ACCESS EXCLUSIVE MODE;

DO $session_event_raw_lane_writer_drain_after_lock$
DECLARE
  configured_roles jsonb := current_setting(
    'opengeni.migration_application_roles', false
  )::jsonb;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0379 session event raw-lane activation requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$session_event_raw_lane_writer_drain_after_lock$;

-- The migration owner must inspect the complete FORCE-RLS inventory. These
-- toggles are transaction-local in effect: any failed parity proof rolls the
-- whole migration back with FORCE still enabled.
ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_event_cursors NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_events NO FORCE ROW LEVEL SECURITY;

DO $session_event_cursor_activation_parity$
DECLARE
  mismatch record;
BEGIN
  SELECT
    session.id AS session_id,
    session.last_sequence AS projected_sequence,
    cursor.last_sequence AS cursor_sequence,
    COUNT(event.sequence)::integer AS event_count,
    MIN(event.sequence)::integer AS first_event_sequence,
    COALESCE(MAX(event.sequence), 0)::integer AS event_sequence
  INTO mismatch
  FROM sessions session
  LEFT JOIN session_event_cursors cursor
    ON cursor.account_id = session.account_id
   AND cursor.workspace_id = session.workspace_id
   AND cursor.session_id = session.id
  LEFT JOIN session_events event
    ON event.account_id = session.account_id
   AND event.workspace_id = session.workspace_id
   AND event.session_id = session.id
  GROUP BY session.id, session.last_sequence, cursor.last_sequence
  HAVING cursor.last_sequence IS NULL
    OR COUNT(event.sequence)::integer <> cursor.last_sequence
    OR cursor.last_sequence <> COALESCE(MAX(event.sequence), 0)::integer
    OR (
      cursor.last_sequence = 0
      AND MIN(event.sequence) IS NOT NULL
    )
    OR (
      cursor.last_sequence > 0
      AND MIN(event.sequence)::integer <> 1
    )
    OR session.last_sequence > cursor.last_sequence
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'session event raw-lane activation refused because cursor parity failed',
      DETAIL = pg_catalog.format(
        'session_id=%s session=%s cursor=%s count=%s first=%s event=%s',
        mismatch.session_id,
        mismatch.projected_sequence,
        mismatch.cursor_sequence,
        mismatch.event_count,
        mismatch.first_event_sequence,
        mismatch.event_sequence
      );
  END IF;
END
$session_event_cursor_activation_parity$;

ALTER TABLE session_events FORCE ROW LEVEL SECURITY;
ALTER TABLE session_event_cursors FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

CREATE FUNCTION normalize_legacy_session_event_sequence_from_cursor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $normalize_legacy_session_event_sequence_from_cursor$
DECLARE
  fenced_access_capability_id uuid;
  current_sequence integer;
  raw_range jsonb;
BEGIN
  raw_range := nullif(
    pg_catalog.current_setting('opengeni.session_event_raw_cursor_range_v1', true),
    ''
  )::jsonb;
  IF NEW.type IN (
      'agent.message.delta',
      'agent.reasoning.delta',
      'sandbox.command.output.delta',
      'terminal.pty.output.delta'
    )
    AND raw_range ->> 'accountId' = NEW.account_id::text
    AND raw_range ->> 'workspaceId' = NEW.workspace_id::text
    AND raw_range ->> 'sessionId' = NEW.session_id::text
    AND NEW.sequence BETWEEN
      (raw_range ->> 'firstSequence')::integer
      AND (raw_range ->> 'lastSequence')::integer
  THEN
    RETURN NEW;
  END IF;

  PERFORM pg_catalog.set_config(
    'opengeni.session_variable_set_attachments_v1',
    '1',
    true
  );
  fenced_access_capability_id :=
    opengeni_private.open_session_tenancy_fenced_access(
      session_tenancy_fence_target_schema()
    );
  SELECT cursor.last_sequence
  INTO current_sequence
  FROM session_event_cursors cursor
  WHERE cursor.account_id = NEW.account_id
    AND cursor.workspace_id = NEW.workspace_id
    AND cursor.session_id = NEW.session_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'session event cursor is missing for a legacy event writer';
  END IF;

  -- New cursor writers submit the complete contiguous range and are validated
  -- by the AFTER STATEMENT trigger. A legacy writer can submit the stale
  -- sessions.last_sequence + 1 after raw traffic; rebase only that already-
  -- consumed value. Multi-row gaps still fail closed in the statement trigger.
  IF NEW.sequence <= current_sequence THEN
    NEW.sequence := current_sequence + 1;
  END IF;
  PERFORM opengeni_private.close_session_tenancy_fenced_access(
    fenced_access_capability_id
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  IF fenced_access_capability_id IS NOT NULL THEN
    PERFORM opengeni_private.close_session_tenancy_fenced_access(
      fenced_access_capability_id
    );
  END IF;
  RAISE;
END
$normalize_legacy_session_event_sequence_from_cursor$;

CREATE FUNCTION prevent_session_event_projection_regression()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $prevent_session_event_projection_regression$
DECLARE
  fenced_access_capability_id uuid;
  current_sequence integer;
BEGIN
  IF NEW.last_sequence IS NOT DISTINCT FROM OLD.last_sequence THEN
    RETURN NEW;
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.session_variable_set_attachments_v1',
    '1',
    true
  );
  fenced_access_capability_id :=
    opengeni_private.open_session_tenancy_fenced_access(
      session_tenancy_fence_target_schema()
    );
  SELECT cursor.last_sequence
  INTO current_sequence
  FROM session_event_cursors cursor
  WHERE cursor.account_id = NEW.account_id
    AND cursor.workspace_id = NEW.workspace_id
    AND cursor.session_id = NEW.id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'session event cursor is missing for a session projection update';
  END IF;
  -- Event insertion is the only cursor advance. A semantic writer that updates
  -- session state before its event is snapped to the current cursor, and the
  -- validated AFTER INSERT trigger advances the compatibility projection once
  -- the event exists. No direct/manual update may lead or regress authority.
  NEW.last_sequence := current_sequence;
  PERFORM opengeni_private.close_session_tenancy_fenced_access(
    fenced_access_capability_id
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  IF fenced_access_capability_id IS NOT NULL THEN
    PERFORM opengeni_private.close_session_tenancy_fenced_access(
      fenced_access_capability_id
    );
  END IF;
  RAISE;
END
$prevent_session_event_projection_regression$;

CREATE FUNCTION assert_session_event_projection_not_ahead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $assert_session_event_projection_not_ahead$
DECLARE
  fenced_access_capability_id uuid;
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
  SELECT cursor.last_sequence
  INTO current_sequence
  FROM session_event_cursors cursor
  WHERE cursor.account_id = NEW.account_id
    AND cursor.workspace_id = NEW.workspace_id
    AND cursor.session_id = NEW.id;
  IF NOT FOUND THEN
    -- A session inserted and then deleted in the same transaction legitimately
    -- loses its cursor through ON DELETE CASCADE before this deferred trigger
    -- runs. Consult the wider row only on that exceptional path; ordinary
    -- validation stays entirely on the narrow authoritative cursor and does
    -- not evaluate unrelated sessions RLS protocol policies.
    PERFORM 1 FROM sessions session
    WHERE session.account_id = NEW.account_id
      AND session.workspace_id = NEW.workspace_id
      AND session.id = NEW.id;
    IF NOT FOUND THEN
      PERFORM opengeni_private.close_session_tenancy_fenced_access(
        fenced_access_capability_id
      );
      RETURN NULL;
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'session event compatibility projection has no cursor',
      DETAIL = pg_catalog.format(
        'session_id=%s session=%s',
        NEW.id,
        NEW.last_sequence
      );
  END IF;
  IF NEW.last_sequence > current_sequence THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'session event compatibility projection is ahead of its cursor',
      DETAIL = pg_catalog.format(
        'session_id=%s session=%s cursor=%s',
        NEW.id,
        NEW.last_sequence,
        current_sequence
      );
  END IF;
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
$assert_session_event_projection_not_ahead$;

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
      COUNT(*)::integer AS sequence_count,
      COUNT(DISTINCT sequence)::integer AS distinct_sequence_count,
      BOOL_OR(type NOT IN (
        'agent.message.delta',
        'agent.reasoning.delta',
        'sandbox.command.output.delta',
        'terminal.pty.output.delta'
      )) AS advances_activity
    FROM inserted_session_events
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

DO $session_event_raw_lane_function_paths$
DECLARE
  target_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.normalize_legacy_session_event_sequence_from_cursor() '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.prevent_session_event_projection_regression() '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.assert_session_event_projection_not_ahead() '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.advance_session_event_cursors_for_inserted_events() '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
END
$session_event_raw_lane_function_paths$;

REVOKE ALL ON FUNCTION normalize_legacy_session_event_sequence_from_cursor() FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_session_event_projection_regression() FROM PUBLIC;
REVOKE ALL ON FUNCTION assert_session_event_projection_not_ahead() FROM PUBLIC;
REVOKE ALL ON FUNCTION advance_session_event_cursors_for_inserted_events() FROM PUBLIC;

CREATE TRIGGER session_events_normalize_legacy_cursor_sequence
BEFORE INSERT ON session_events
FOR EACH ROW
EXECUTE FUNCTION normalize_legacy_session_event_sequence_from_cursor();

CREATE TRIGGER sessions_prevent_event_projection_regression
BEFORE UPDATE OF last_sequence ON sessions
FOR EACH ROW
EXECUTE FUNCTION prevent_session_event_projection_regression();

CREATE CONSTRAINT TRIGGER sessions_event_projection_cursor_guard
AFTER INSERT OR UPDATE OF last_sequence ON sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION assert_session_event_projection_not_ahead();