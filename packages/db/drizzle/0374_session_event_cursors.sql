-- deployment-mode: rolling
-- Phase A of the narrow session-event sequencer: mirror and verify every
-- committed append before any writer stops using sessions.last_sequence.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE session_event_cursors (
  session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  last_sequence integer NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_event_cursors_sequence_check CHECK (last_sequence >= 0),
  CONSTRAINT session_event_cursors_revision_check CHECK (revision >= 0),
  CONSTRAINT session_event_cursors_workspace_account_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT session_event_cursors_workspace_session_fk
    FOREIGN KEY (workspace_id, session_id)
    REFERENCES sessions(workspace_id, id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX session_event_cursors_workspace_session_idx
  ON session_event_cursors(workspace_id, session_id);

COMMENT ON TABLE session_event_cursors IS
  'Narrow exact per-session event cursor. Migration 0374 mirrors sessions.last_sequence; a later activation may make this row the allocator and admission gate.';
COMMENT ON COLUMN session_event_cursors.revision IS
  'Monotonic count of successful event-insert statements that advanced this cursor.';

ALTER TABLE session_event_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_event_cursors FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON session_event_cursors
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $session_event_cursor_owner_policies$
DECLARE
  target_schema text := pg_catalog.current_schema();
  target_schema_oid oid := pg_catalog.current_schema()::pg_catalog.regnamespace;
  migration_owner text := current_user;
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE POLICY session_tenancy_fence_inventory_read ON %I.session_event_cursors '
      || 'FOR SELECT USING ('
      || '%I.session_tenancy_fence_owner_policy_active('
      || 'current_user, %L, %s::oid, workspace_id, true))',
    target_schema,
    target_schema,
    migration_owner,
    target_schema_oid
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY session_tenancy_fenced_owner_write ON %I.session_event_cursors '
      || 'FOR ALL USING ('
      || '%I.session_tenancy_fence_owner_policy_active('
      || 'current_user, %L, %s::oid, workspace_id, false)) '
      || 'WITH CHECK ('
      || '%I.session_tenancy_fence_owner_policy_active('
      || 'current_user, %L, %s::oid, workspace_id, false))',
    target_schema,
    target_schema,
    migration_owner,
    target_schema_oid,
    target_schema,
    migration_owner,
    target_schema_oid
  );
END
$session_event_cursor_owner_policies$;

-- FORCE RLS remains enabled for runtime roles. Temporarily let the table owner
-- inspect all existing rows while the migration transaction holds the DDL
-- locks, then restore FORCE before commit.
ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_event_cursors NO FORCE ROW LEVEL SECURITY;

DO $session_event_cursor_parity$
DECLARE
  mismatch record;
BEGIN
  SELECT
    sessions.id AS session_id,
    sessions.last_sequence AS stored_sequence,
    COALESCE(MAX(session_events.sequence), 0)::integer AS event_sequence
  INTO mismatch
  FROM sessions
  LEFT JOIN session_events
    ON session_events.workspace_id = sessions.workspace_id
   AND session_events.session_id = sessions.id
  GROUP BY sessions.id, sessions.last_sequence
  HAVING sessions.last_sequence <> COALESCE(MAX(session_events.sequence), 0)::integer
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'session event cursor backfill refused because sessions.last_sequence diverges from durable event history',
      DETAIL = pg_catalog.format(
        'session_id=%s stored_sequence=%s event_sequence=%s',
        mismatch.session_id,
        mismatch.stored_sequence,
        mismatch.event_sequence
      );
  END IF;
END
$session_event_cursor_parity$;

INSERT INTO session_event_cursors (
  session_id,
  account_id,
  workspace_id,
  last_sequence
)
SELECT id, account_id, workspace_id, last_sequence
FROM sessions;

ALTER TABLE session_event_cursors FORCE ROW LEVEL SECURITY;
ALTER TABLE session_events FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

CREATE FUNCTION initialize_session_event_cursors_for_inserted_sessions()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $initialize_session_event_cursors$
BEGIN
  INSERT INTO session_event_cursors (
    session_id,
    account_id,
    workspace_id,
    last_sequence
  )
  -- A session row must exist before any event can reference it, so a newly
  -- inserted session has no durable event history yet. Some lifecycle
  -- functions pre-seed sessions.last_sequence for events they insert later in
  -- the same transaction; copying that future projection here would make the
  -- first real event look like a duplicate.
  SELECT id, account_id, workspace_id, 0
  FROM inserted_sessions
  ON CONFLICT (session_id) DO NOTHING;
  RETURN NULL;
END
$initialize_session_event_cursors$;

CREATE TRIGGER sessions_initialize_event_cursors
AFTER INSERT ON sessions
REFERENCING NEW TABLE AS inserted_sessions
FOR EACH STATEMENT
EXECUTE FUNCTION initialize_session_event_cursors_for_inserted_sessions();

CREATE FUNCTION advance_session_event_cursors_for_inserted_events()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $advance_session_event_cursors$
DECLARE
  inserted_group record;
  current_sequence integer;
BEGIN
  FOR inserted_group IN
    SELECT
      account_id,
      workspace_id,
      session_id,
      MIN(sequence)::integer AS first_sequence,
      MAX(sequence)::integer AS last_sequence,
      COUNT(*)::integer AS sequence_count,
      COUNT(DISTINCT sequence)::integer AS distinct_sequence_count
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
        MESSAGE = 'session event cursor is missing for an inserted event',
        DETAIL = pg_catalog.format(
          'workspace_id=%s session_id=%s',
          inserted_group.workspace_id,
          inserted_group.session_id
        );
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
        updated_at = now()
    WHERE account_id = inserted_group.account_id
      AND workspace_id = inserted_group.workspace_id
      AND session_id = inserted_group.session_id
      AND last_sequence = current_sequence;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'session event cursor changed while applying an inserted event statement';
    END IF;
  END LOOP;
  RETURN NULL;
END
$advance_session_event_cursors$;

CREATE TRIGGER session_events_advance_event_cursors
AFTER INSERT ON session_events
REFERENCING NEW TABLE AS inserted_session_events
FOR EACH STATEMENT
EXECUTE FUNCTION advance_session_event_cursors_for_inserted_events();

DO $session_event_cursor_runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON session_event_cursors TO opengeni_app;
  END IF;
END
$session_event_cursor_runtime_grants$;