-- deployment-mode: rolling
-- Idle-session archive (see docs/session-storage-lifecycle.md).
--
-- An archived session keeps its row, turns, attempts, goals and readable
-- timeline events, so every existing reader and every durable reference
-- (task notes, artifact versions, usage facts) is unchanged. The bulky content
-- that only an executing session needs (model history, machine inputs, tool
-- catalogs, model-request snapshots, streamed fragments, telemetry events) is
-- written to a verified bundle in object storage and then purged here.
--
-- Archiving is one-way: an archived session is read-only. The guard below
-- extends the existing imported-archive execution guard, so admission,
-- history and goal writers refuse both kinds of inert session in the database.
SET LOCAL lock_timeout = '5s';

ALTER TABLE sessions
  ADD COLUMN keep_live boolean NOT NULL DEFAULT false,
  ADD COLUMN content_archive_state text,
  ADD COLUMN content_archive_started_at timestamptz,
  ADD COLUMN content_archived_at timestamptz,
  ADD COLUMN content_archive jsonb,
  ADD COLUMN content_archive_purged_at timestamptz;

ALTER TABLE sessions ADD CONSTRAINT sessions_content_archive_state_check CHECK (
  (content_archive_state IS NULL AND content_archive_started_at IS NULL
    AND content_archived_at IS NULL AND content_archive IS NULL
    AND content_archive_purged_at IS NULL)
  OR (content_archive_state = 'archiving' AND content_archive_started_at IS NOT NULL
    AND content_archived_at IS NULL AND jsonb_typeof(content_archive) = 'object'
    AND content_archive_purged_at IS NULL)
  OR (content_archive_state = 'archived' AND content_archive_started_at IS NOT NULL
    AND content_archived_at IS NOT NULL AND jsonb_typeof(content_archive) = 'object'
    AND content_archive ? 'sha256')
);
ALTER TABLE sessions ADD CONSTRAINT sessions_content_archive_size_check
  CHECK (content_archive IS NULL OR octet_length(content_archive::text) <= 65536);

CREATE INDEX sessions_content_archive_state_idx
  ON sessions (content_archive_state, content_archive_started_at)
  WHERE content_archive_state IS NOT NULL;

-- Archiving sessions are fenced from execution as soon as the archive starts,
-- so a message arriving mid-archive cannot be lost with the purged history.
CREATE OR REPLACE FUNCTION refuse_imported_archive_execution() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  archive_id text;
  archive_state text;
BEGIN
  SELECT imported_archive_import_id, content_archive_state INTO archive_id, archive_state
  FROM sessions
  WHERE workspace_id = NEW.workspace_id AND id = NEW.session_id FOR NO KEY UPDATE;
  IF archive_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'OG002', MESSAGE = 'SESSION_IMPORTED_READ_ONLY';
  END IF;
  IF archive_state IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'OG002', MESSAGE = 'SESSION_ARCHIVED_READ_ONLY';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION refuse_imported_archive_execution() FROM PUBLIC;

CREATE TRIGGER session_system_updates_content_archive_guard
  BEFORE INSERT ON session_system_updates FOR EACH ROW
  EXECUTE FUNCTION refuse_imported_archive_execution();

-- Session identity guard (from 0560), extended for content archives: an
-- archived session cannot become a fork source or a parent, and a recorded
-- archive is permanent. Its state, manifest and keep-live setting are frozen;
-- only purge completion may still be recorded.
CREATE OR REPLACE FUNCTION guard_imported_archive_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  -- Old fork/child writers must not turn historical input into executable
  -- content. This is a source guard, not just a guard on the destination marker.
  IF TG_OP = 'INSERT' OR
    (NEW.forked_from_session_id, NEW.parent_session_id) IS DISTINCT FROM
    (OLD.forked_from_session_id, OLD.parent_session_id) THEN
    IF EXISTS (SELECT 1 FROM sessions source WHERE source.account_id = NEW.account_id
      AND source.id IN (NEW.forked_from_session_id, NEW.parent_session_id)
      AND source.imported_archive_import_id IS NOT NULL FOR NO KEY UPDATE) THEN
      RAISE EXCEPTION USING ERRCODE = 'OG002', MESSAGE = 'SESSION_IMPORTED_READ_ONLY';
    END IF;
    IF EXISTS (SELECT 1 FROM sessions source WHERE source.account_id = NEW.account_id
      AND source.id IN (NEW.forked_from_session_id, NEW.parent_session_id)
      AND source.content_archive_state IS NOT NULL FOR NO KEY UPDATE) THEN
      RAISE EXCEPTION USING ERRCODE = 'OG002', MESSAGE = 'SESSION_ARCHIVED_READ_ONLY';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.imported_archive_import_id IS NOT NULL AND
    (NEW.imported_archive_import_id, NEW.imported_archive_imported_at,
      NEW.imported_archive_request_hash, NEW.imported_archive_subject_id)
    IS DISTINCT FROM
    (OLD.imported_archive_import_id, OLD.imported_archive_imported_at,
      OLD.imported_archive_request_hash, OLD.imported_archive_subject_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'OG002', MESSAGE = 'SESSION_IMPORTED_READ_ONLY';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.content_archive_state = 'archived' AND
    (NEW.content_archive_state, NEW.content_archive_started_at, NEW.content_archived_at,
      NEW.content_archive, NEW.keep_live)
    IS DISTINCT FROM
    (OLD.content_archive_state, OLD.content_archive_started_at, OLD.content_archived_at,
      OLD.content_archive, OLD.keep_live) THEN
    RAISE EXCEPTION USING ERRCODE = 'OG002', MESSAGE = 'SESSION_ARCHIVED_READ_ONLY';
  END IF;
  IF NEW.imported_archive_import_id IS NOT NULL
    AND (TG_OP = 'INSERT' OR OLD.imported_archive_import_id IS NULL) THEN
    IF EXISTS (SELECT 1 FROM session_turns WHERE workspace_id = NEW.workspace_id AND session_id = NEW.id)
      OR EXISTS (SELECT 1 FROM session_turn_attempts WHERE workspace_id = NEW.workspace_id AND session_id = NEW.id)
      OR EXISTS (SELECT 1 FROM session_history_items WHERE workspace_id = NEW.workspace_id AND session_id = NEW.id)
      OR EXISTS (SELECT 1 FROM session_goals WHERE workspace_id = NEW.workspace_id AND session_id = NEW.id)
      OR EXISTS (SELECT 1 FROM session_workflow_wake_outbox WHERE workspace_id = NEW.workspace_id AND session_id = NEW.id)
      OR EXISTS (SELECT 1 FROM session_events WHERE workspace_id = NEW.workspace_id AND session_id = NEW.id) THEN
      RAISE EXCEPTION USING ERRCODE = 'OG002', MESSAGE = 'SESSION_IMPORTED_READ_ONLY';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_imported_archive_identity() FROM PUBLIC;

-- Discovery for the global maintenance worker. Returns routing ids only.
-- A session qualifies when it, and everything that could wake it, has been
-- quiet for the idle period. Anything that could still need the session's
-- executable history keeps it live.
CREATE FUNCTION opengeni_private.session_archive_candidates(
  p_idle_seconds bigint,
  p_limit integer,
  p_session_id uuid DEFAULT NULL
)
RETURNS TABLE (account_id uuid, workspace_id uuid, session_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- EMBED-SAFE: data tables live in the caller-selected schema, matching the
-- existing global-reaper convention; opengeni_private is absolute.
AS $$
  WITH params AS (
    SELECT clock_timestamp() - make_interval(secs => greatest(p_idle_seconds, 3600)) AS cutoff
  )
  SELECT S.account_id, S.workspace_id, S.id
  FROM sessions S, params P
  WHERE S.content_archive_state IS NULL
    AND (p_session_id IS NULL OR S.id = p_session_id)
    AND NOT S.keep_live
    AND S.imported_archive_import_id IS NULL
    AND S.status IN ('idle', 'failed', 'cancelled')
    AND S.active_turn_id IS NULL
    AND S.input_wait_until IS NULL
    AND S.created_at < P.cutoff
    AND S.updated_at < P.cutoff
    AND NOT EXISTS (
      SELECT 1 FROM session_turns T
      WHERE T.workspace_id = S.workspace_id AND T.session_id = S.id
        AND (T.status IN ('queued', 'running', 'requires_action', 'recovering', 'waiting_capacity')
          OR greatest(T.created_at, T.updated_at) >= P.cutoff))
    AND NOT EXISTS (
      SELECT 1 FROM session_human_input_requests H
      WHERE H.workspace_id = S.workspace_id AND H.session_id = S.id AND H.status = 'pending')
    AND NOT EXISTS (
      SELECT 1 FROM session_goals G
      WHERE G.workspace_id = S.workspace_id AND G.session_id = S.id AND G.status = 'active')
    AND NOT EXISTS (
      SELECT 1 FROM session_system_updates U
      WHERE U.workspace_id = S.workspace_id AND U.session_id = S.id AND U.state = 'pending')
    AND NOT EXISTS (
      SELECT 1 FROM session_system_update_outbox O
      WHERE O.workspace_id = S.workspace_id AND O.target_session_id = S.id
        AND O.status = 'pending')
    AND NOT EXISTS (
      SELECT 1 FROM session_background_commands B
      WHERE B.workspace_id = S.workspace_id AND B.session_id = S.id
        AND B.state IN ('running', 'stopping'))
    AND NOT EXISTS (
      SELECT 1 FROM scheduled_tasks K
      WHERE K.workspace_id = S.workspace_id AND K.reusable_session_id = S.id
        AND K.deleted_at IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM site_auth_connections A
      WHERE A.workspace_id = S.workspace_id AND A.maintenance_session_id = S.id)
    AND NOT EXISTS (
      SELECT 1 FROM sessions C
      WHERE C.workspace_id = S.workspace_id AND C.parent_session_id = S.id
        AND C.content_archive_state IS NULL
        AND (C.status NOT IN ('idle', 'failed', 'cancelled') OR C.updated_at >= P.cutoff))
  ORDER BY S.updated_at, S.id
  LIMIT least(greatest(p_limit, 0), 100);
$$;

-- Purge one bounded batch of archived content. Refuses unless the session's
-- archive is recorded as verified ('archived' with a locator). Each table is
-- explicit; deletion order respects every foreign key between them.
CREATE FUNCTION opengeni_private.purge_archived_session_content(
  p_workspace_id uuid,
  p_session_id uuid,
  p_table text,
  p_limit integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  archive_state text;
  archive_locator jsonb;
  batch integer := least(greatest(p_limit, 1), 10000);
  deleted integer := 0;
BEGIN
  SELECT content_archive_state, content_archive INTO archive_state, archive_locator
  FROM sessions WHERE workspace_id = p_workspace_id AND id = p_session_id
  FOR NO KEY UPDATE;
  IF archive_state IS DISTINCT FROM 'archived'
    OR archive_locator IS NULL OR archive_locator->>'sha256' IS NULL THEN
    RAISE EXCEPTION 'session content is not archived' USING ERRCODE = '55000';
  END IF;
  CASE p_table
  WHEN 'session_realtime_entries' THEN
    DELETE FROM session_realtime_entries WHERE ctid IN (
      SELECT ctid FROM session_realtime_entries
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id LIMIT batch);
  WHEN 'session_system_updates' THEN
    DELETE FROM session_system_updates WHERE ctid IN (
      SELECT ctid FROM session_system_updates
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id LIMIT batch);
  WHEN 'session_history_items' THEN
    DELETE FROM session_history_items WHERE ctid IN (
      SELECT ctid FROM session_history_items
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id LIMIT batch);
  WHEN 'session_attempt_codemode_calls' THEN
    DELETE FROM session_attempt_codemode_calls WHERE ctid IN (
      SELECT ctid FROM session_attempt_codemode_calls
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id LIMIT batch);
  WHEN 'session_attempt_tool_catalogs' THEN
    DELETE FROM session_attempt_tool_catalogs WHERE ctid IN (
      SELECT ctid FROM session_attempt_tool_catalogs
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id LIMIT batch);
  WHEN 'session_attempt_model_context_snapshots' THEN
    DELETE FROM session_attempt_model_context_snapshots WHERE ctid IN (
      SELECT ctid FROM session_attempt_model_context_snapshots
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id LIMIT batch);
  WHEN 'session_content_blobs' THEN
    DELETE FROM session_content_blobs WHERE ctid IN (
      SELECT ctid FROM session_content_blobs
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id LIMIT batch);
  WHEN 'session_pending_tool_calls' THEN
    DELETE FROM session_pending_tool_calls WHERE ctid IN (
      SELECT ctid FROM session_pending_tool_calls
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id LIMIT batch);
  WHEN 'session_events' THEN
    -- Only originals and duplicates of retained types reference each other
    -- (duplicates are agent.model.usage, which stays), so order is irrelevant.
    DELETE FROM session_events WHERE ctid IN (
      SELECT ctid FROM session_events
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id
        AND type IN (SELECT opengeni_private.archived_session_event_types())
      LIMIT batch);
  ELSE
    RAISE EXCEPTION 'unsupported archived session table' USING ERRCODE = '22023';
  END CASE;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

-- Event types that only an executing session or a debugger needs. Everything
-- else stays in the timeline and remains readable by people and agents.
CREATE FUNCTION opengeni_private.archived_session_event_types()
RETURNS SETOF text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT unnest(ARRAY[
    'agent.message.delta',
    'agent.reasoning.delta',
    'sandbox.command.output.delta',
    'terminal.pty.output.delta',
    'agent.model.request',
    'system.update.pending',
    'system.update.delivered',
    'system.update.settled',
    'turn.startup.phase.started',
    'turn.startup.phase.completed',
    'codex.credential.selected',
    'turn.event.rejected_late'
  ]);
$$;

REVOKE ALL ON FUNCTION opengeni_private.session_archive_candidates(bigint, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.purge_archived_session_content(uuid, uuid, text, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.archived_session_event_types() FROM PUBLIC;
DO $archive_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.session_archive_candidates(bigint, integer, uuid),
      opengeni_private.purge_archived_session_content(uuid, uuid, text, integer),
      opengeni_private.archived_session_event_types()
      TO opengeni_app;
  END IF;
END
$archive_grants$;

-- Deleting a session removes its archive objects. The trigger records the
-- object keys durably in the deleting transaction; the maintenance worker
-- deletes the objects and then the queue rows. Content-free: keys only.
CREATE TABLE opengeni_private.session_archive_object_deletions (
  object_key text PRIMARY KEY,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  CONSTRAINT session_archive_object_deletions_key_check
    CHECK (octet_length(object_key) BETWEEN 1 AND 1024)
);
REVOKE ALL ON TABLE opengeni_private.session_archive_object_deletions FROM PUBLIC;

CREATE FUNCTION opengeni_private.enqueue_session_archive_object_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  planned_key text;
BEGIN
  IF OLD.content_archive IS NOT NULL THEN
    FOR planned_key IN
      SELECT value FROM jsonb_array_elements_text(
        coalesce(OLD.content_archive->'objectKeys', '[]'::jsonb))
    LOOP
      INSERT INTO opengeni_private.session_archive_object_deletions
        (object_key, account_id, workspace_id, session_id)
      VALUES (planned_key, OLD.account_id, OLD.workspace_id, OLD.id)
      ON CONFLICT (object_key) DO NOTHING;
    END LOOP;
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION opengeni_private.enqueue_session_archive_object_deletion() FROM PUBLIC;
CREATE TRIGGER sessions_archive_object_deletion
  AFTER DELETE ON sessions FOR EACH ROW
  WHEN (OLD.content_archive IS NOT NULL)
  EXECUTE FUNCTION opengeni_private.enqueue_session_archive_object_deletion();

CREATE FUNCTION opengeni_private.claim_session_archive_object_deletions(
  p_claim_timeout_seconds integer,
  p_limit integer
)
RETURNS TABLE (object_key text, workspace_id uuid, session_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH candidates AS (
    SELECT D.object_key FROM opengeni_private.session_archive_object_deletions D
    WHERE D.claimed_at IS NULL
      OR D.claimed_at < clock_timestamp() - make_interval(secs => greatest(p_claim_timeout_seconds, 60))
    ORDER BY D.enqueued_at, D.object_key
    LIMIT least(greatest(p_limit, 0), 1000)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE opengeni_private.session_archive_object_deletions D
  SET claimed_at = clock_timestamp(), attempts = D.attempts + 1
  FROM candidates C WHERE D.object_key = C.object_key
  RETURNING D.object_key, D.workspace_id, D.session_id;
$$;

CREATE FUNCTION opengeni_private.complete_session_archive_object_deletion(p_object_key text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH deleted AS (
    DELETE FROM opengeni_private.session_archive_object_deletions
    WHERE object_key = p_object_key RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM deleted);
$$;

REVOKE ALL ON FUNCTION opengeni_private.claim_session_archive_object_deletions(integer, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.complete_session_archive_object_deletion(text) FROM PUBLIC;
DO $archive_object_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.claim_session_archive_object_deletions(integer, integer),
      opengeni_private.complete_session_archive_object_deletion(text)
      TO opengeni_app;
  END IF;
END
$archive_object_grants$;

-- Abandon an archive that never completed (crash, upload failure). The
-- planned object keys move to the deletion queue in the same transaction, so a
-- partially uploaded bundle is never orphaned. A completed archive cannot be
-- abandoned.
CREATE FUNCTION opengeni_private.abandon_session_content_archive(
  p_workspace_id uuid,
  p_session_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  target record;
  planned_key text;
BEGIN
  SELECT account_id, content_archive_state, content_archive INTO target
  FROM sessions WHERE workspace_id = p_workspace_id AND id = p_session_id
  FOR NO KEY UPDATE;
  IF NOT FOUND OR target.content_archive_state IS DISTINCT FROM 'archiving' THEN
    RETURN false;
  END IF;
  FOR planned_key IN
    SELECT value FROM jsonb_array_elements_text(
      coalesce(target.content_archive->'objectKeys', '[]'::jsonb))
  LOOP
    INSERT INTO opengeni_private.session_archive_object_deletions
      (object_key, account_id, workspace_id, session_id)
    VALUES (planned_key, target.account_id, p_workspace_id, p_session_id)
    ON CONFLICT (object_key) DO NOTHING;
  END LOOP;
  UPDATE sessions
  SET content_archive_state = NULL, content_archive_started_at = NULL, content_archive = NULL
  WHERE workspace_id = p_workspace_id AND id = p_session_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION opengeni_private.abandon_session_content_archive(uuid, uuid) FROM PUBLIC;
DO $abandon_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.abandon_session_content_archive(uuid, uuid)
      TO opengeni_app;
  END IF;
END
$abandon_grants$;

-- Recovery discovery: archives a crashed worker left mid-way. 'archiving'
-- past the stale period is abandoned and retried later; 'archived' without a
-- finished purge resumes purging. Routing ids only.
CREATE FUNCTION opengeni_private.session_archive_unfinished(
  p_stale_seconds bigint,
  p_limit integer
)
RETURNS TABLE (account_id uuid, workspace_id uuid, session_id uuid, state text)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT S.account_id, S.workspace_id, S.id, S.content_archive_state
  FROM sessions S
  WHERE (S.content_archive_state = 'archiving'
      AND S.content_archive_started_at
        < clock_timestamp() - make_interval(secs => greatest(p_stale_seconds, 300)))
    OR (S.content_archive_state = 'archived' AND S.content_archive_purged_at IS NULL)
  ORDER BY S.content_archive_started_at, S.id
  LIMIT least(greatest(p_limit, 0), 100);
$$;
REVOKE ALL ON FUNCTION opengeni_private.session_archive_unfinished(bigint, integer) FROM PUBLIC;
DO $unfinished_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.session_archive_unfinished(bigint, integer)
      TO opengeni_app;
  END IF;
END
$unfinished_grants$;
