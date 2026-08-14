-- deployment-mode: maintenance
-- Replace the hidden per-row activity-counter allocator with one explicit
-- once-per-transaction commit gate. Readers become ordinary MVCC reads; writers
-- settle every other constraint before briefly advancing the workspace clock.
-- The durable ledger remains the source of truth; no application-local cache participates.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

ALTER TABLE "sessions"
  ADD COLUMN "activity_revision_pending_xid" bigint;

CREATE INDEX "sessions_workspace_activity_pending_idx"
  ON "sessions" ("workspace_id", "activity_revision_pending_xid", "id")
  WHERE "activity_revision_pending_xid" IS NOT NULL;

CREATE OR REPLACE FUNCTION opengeni_private.ensure_workspace_session_activity_revision(
  target_schema text,
  target_workspace_id uuid,
  target_account_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  previous_account_id text := current_setting('opengeni.account_id', true);
  previous_workspace_id text := current_setting('opengeni.workspace_id', true);
BEGIN
  -- FORCE RLS applies to supported non-bypass table owners too. Establish only
  -- the row's own trusted scope, then restore the caller's transaction-local
  -- context so structural initialization cannot leak authority downstream.
  PERFORM set_config('opengeni.account_id', target_account_id::text, true);
  PERFORM set_config('opengeni.workspace_id', target_workspace_id::text, true);
  EXECUTE format(
    'INSERT INTO %I.workspace_session_activity_revisions '
    || '(workspace_id, account_id, revision) VALUES ($1, $2, 0) '
    || 'ON CONFLICT (workspace_id) DO NOTHING',
    target_schema
  )
  USING target_workspace_id, target_account_id;
  PERFORM set_config('opengeni.account_id', coalesce(previous_account_id, ''), true);
  PERFORM set_config('opengeni.workspace_id', coalesce(previous_workspace_id, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.account_id', coalesce(previous_account_id, ''), true);
  PERFORM set_config('opengeni.workspace_id', coalesce(previous_workspace_id, ''), true);
  RAISE;
END;
$function$;

REVOKE ALL ON FUNCTION opengeni_private.ensure_workspace_session_activity_revision(
  text, uuid, uuid
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION opengeni_private.initialize_workspace_session_activity_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  PERFORM opengeni_private.ensure_workspace_session_activity_revision(
    TG_TABLE_SCHEMA,
    NEW.id,
    NEW.account_id
  );
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION opengeni_private.initialize_workspace_session_activity_revision()
  FROM PUBLIC;

CREATE TRIGGER workspaces_initialize_session_activity_revision
AFTER INSERT ON "workspaces"
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.initialize_workspace_session_activity_revision();

-- Install the structural initializer before taking the existing-workspace
-- snapshot. CREATE TRIGGER fences concurrent workspace writers; the subsequent
-- conflict-safe backfill covers every row that committed before the trigger,
-- while later rows are covered by the trigger itself. The same private helper
-- keeps this path valid when the schema owner is subject to FORCE RLS.
SELECT opengeni_private.ensure_workspace_session_activity_revision(
  current_schema(),
  "id",
  "account_id"
)
FROM "workspaces";

-- Counter lifecycle is now structural: the workspace trigger creates rows and
-- the foreign-key cascade removes them. The application may only observe and
-- advance an existing counter at the explicit commit gate.
DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'REVOKE INSERT, DELETE ON TABLE %I.workspace_session_activity_revisions FROM opengeni_app',
      target_schema
    );
  END IF;
END $grants$;

-- UPDATE remains necessary for the runtime finalizer, but the table itself
-- rejects every other write shape. This catches a forgotten wrapper even when
-- application code reaches for the counter directly instead of a session row.
CREATE OR REPLACE FUNCTION opengeni_private.guard_workspace_session_activity_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  gate_state text := nullif(current_setting('opengeni.session_activity_gate_state', true), '');
  gate_workspace_id uuid := nullif(
    current_setting('opengeni.session_activity_gate_workspace_id', true),
    ''
  )::uuid;
BEGIN
  IF gate_state <> 'finalizing'
    OR gate_workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.revision IS DISTINCT FROM OLD.revision + 1
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Workspace session activity revision requires the finalizing commit gate';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION opengeni_private.guard_workspace_session_activity_revision()
  FROM PUBLIC;

CREATE TRIGGER workspace_session_activity_revision_commit_gate
BEFORE UPDATE ON "workspace_session_activity_revisions"
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.guard_workspace_session_activity_revision();

DROP TRIGGER sessions_assign_activity_revision ON "sessions";
DROP FUNCTION opengeni_private.assign_session_activity_revision();

CREATE OR REPLACE FUNCTION opengeni_private.mark_session_activity_pending()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  gate_state text := nullif(current_setting('opengeni.session_activity_gate_state', true), '');
  gate_workspace_id uuid := nullif(
    current_setting('opengeni.session_activity_gate_workspace_id', true),
    ''
  )::uuid;
  current_xid bigint := pg_current_xact_id()::text::bigint;
BEGIN
  IF gate_state = 'finalizing' THEN
    IF TG_OP <> 'UPDATE'
      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
      OR OLD.activity_revision_pending_xid IS DISTINCT FROM current_xid
      OR NEW.activity_revision_pending_xid IS NOT NULL
      OR NEW.activity_revision <= OLD.activity_revision
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Invalid session activity finalization';
    END IF;
    RETURN NEW;
  END IF;

  IF gate_state <> 'open' OR gate_workspace_id IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Session activity write requires an open workspace commit gate';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.activity_revision <> 0 OR NEW.activity_revision_pending_xid IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'Session activity revision is managed by the commit gate';
    END IF;
  ELSIF NEW.activity_revision IS DISTINCT FROM OLD.activity_revision
    OR NEW.activity_revision_pending_xid IS DISTINCT FROM OLD.activity_revision_pending_xid
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Session activity revision is managed by the commit gate';
  END IF;

  NEW.activity_revision_pending_xid := current_xid;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION opengeni_private.mark_session_activity_pending()
  FROM PUBLIC;

CREATE TRIGGER sessions_mark_activity_pending
BEFORE INSERT OR UPDATE OF "updated_at", "activity_revision", "activity_revision_pending_xid"
ON "sessions"
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.mark_session_activity_pending();

-- A transaction that opens the gate manually but omits the finalizer still
-- cannot commit. The application gate switches to `preparing` before forcing
-- all deferred checks, then clears every pending marker in its final write.
CREATE OR REPLACE FUNCTION opengeni_private.reject_unfinalized_session_activity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  gate_state text := nullif(current_setting('opengeni.session_activity_gate_state', true), '');
  still_pending_xid bigint;
BEGIN
  IF gate_state = 'preparing' THEN
    RETURN NULL;
  END IF;
  EXECUTE format(
    'SELECT activity_revision_pending_xid FROM %I.sessions WHERE id = $1',
    TG_TABLE_SCHEMA
  )
  INTO still_pending_xid
  USING NEW.id;
  IF still_pending_xid IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Session activity transaction reached commit without finalization';
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION opengeni_private.reject_unfinalized_session_activity()
  FROM PUBLIC;

CREATE CONSTRAINT TRIGGER sessions_activity_insert_commit_guard
AFTER INSERT ON "sessions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.activity_revision_pending_xid IS NOT NULL)
EXECUTE FUNCTION opengeni_private.reject_unfinalized_session_activity();

-- The clearing write must queue a second check as well. The application first
-- flushes all existing deferred constraints, re-defers these two guards, stamps
-- every pending row, and then forces both guards against the final row state.
CREATE CONSTRAINT TRIGGER sessions_activity_update_commit_guard
AFTER UPDATE ON "sessions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  NEW.activity_revision_pending_xid IS NOT NULL
  OR OLD.activity_revision_pending_xid IS NOT NULL
)
EXECUTE FUNCTION opengeni_private.reject_unfinalized_session_activity();

RESET statement_timeout;
RESET lock_timeout;
