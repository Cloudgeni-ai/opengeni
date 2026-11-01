-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: marks only chats a member hid with the personal archive (one session_pins row per hidden chat, a few hundred at most) and their sub-chats
-- One kind of archive. The chat Archive action used to hide a chat from one
-- member's list (session_pins.archived); the idle archiver separately moved
-- idle chats to long-term storage (content_archive_state). Archive now means
-- the second: archived_at records that a chat is archived for everyone, and
-- the archiver stores it as soon as it is safe to (no running work), instead
-- of after the idle period. archive_requested_by is who archived it; NULL
-- when the idle archiver did. A chat whose content is stored but which
-- predates this column has archived_at NULL and counts as archived through
-- content_archive_state, so no backfill of stored chats is needed.
--
-- Rolling: both columns are nullable and additive. The previous release never
-- reads them, keeps hiding personally archived chats through session_pins
-- (left unchanged here), and calls session_archive_candidates with the same
-- signature; it only sees requested chats archived sooner.
SET LOCAL lock_timeout = '5s';

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS archive_requested_by text;

-- A new session is never archived, whatever row a fork or copy routine starts
-- from.
CREATE OR REPLACE FUNCTION opengeni_private.session_insert_not_archived()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.archived_at := NULL;
  NEW.archive_requested_by := NULL;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS sessions_insert_not_archived ON sessions;
CREATE TRIGGER sessions_insert_not_archived BEFORE INSERT ON sessions
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.session_insert_not_archived();

-- Archiving or undoing changes every member's list, like the projection
-- columns already watched here.
DROP TRIGGER IF EXISTS sessions_list_projection_update ON sessions;
CREATE TRIGGER sessions_list_projection_update AFTER UPDATE OF initial_message, created_by_kind, created_by_subject_id, scope_subject_id, keep_live, content_archived_at, imported_archive_import_id, imported_archive_imported_at, site_id, archived_at ON sessions FOR EACH ROW WHEN ((old.initial_message IS DISTINCT FROM new.initial_message) OR (old.created_by_kind IS DISTINCT FROM new.created_by_kind) OR (old.created_by_subject_id IS DISTINCT FROM new.created_by_subject_id) OR (old.scope_subject_id IS DISTINCT FROM new.scope_subject_id) OR (old.keep_live IS DISTINCT FROM new.keep_live) OR (old.content_archived_at IS DISTINCT FROM new.content_archived_at) OR (old.imported_archive_import_id IS DISTINCT FROM new.imported_archive_import_id) OR (old.imported_archive_imported_at IS DISTINCT FROM new.imported_archive_imported_at) OR (old.site_id IS DISTINCT FROM new.site_id) OR (old.archived_at IS DISTINCT FROM new.archived_at)) EXECUTE FUNCTION notify_session_list_change();

-- An archived chat (archived_at set, and its ten-second undo window over) is
-- stored as soon as nothing is running in it: the idle period, the age limit
-- and recent activity no longer apply, and a sub-chat blocks it only while it
-- runs. Everything else that keeps a chat live still does.
--
-- The listing (no p_session_id) also returns archived chats whose work has not
-- settled yet (a running turn, an active goal, a pending question), so the
-- worker can stop that work first: an archive whose own stop step was lost,
-- or a chat archived by the backfill below, is not left unstored forever. The
-- per-chat recheck under the session lock (p_session_id) stays strict, so
-- nothing is stored while it runs; the previous release just skips them.
CREATE OR REPLACE FUNCTION opengeni_private.session_archive_candidates(p_idle_seconds bigint, p_limit integer, p_session_id uuid DEFAULT NULL::uuid) RETURNS TABLE(account_id uuid, workspace_id uuid, session_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  WITH params AS (
    SELECT clock_timestamp() - make_interval(secs => greatest(p_idle_seconds, 3600)) AS cutoff,
      clock_timestamp() - interval '13 seconds' AS requested_before
  )
  SELECT S.account_id, S.workspace_id, S.id
  FROM sessions S, params P
  WHERE S.content_archive_state IS NULL
    AND (p_session_id IS NULL OR S.id = p_session_id)
    AND NOT S.keep_live
    AND S.imported_archive_import_id IS NULL
    AND (S.archived_at < P.requested_before OR S.created_at < P.cutoff)
    AND ((p_session_id IS NULL AND S.archived_at < P.requested_before) OR (
    S.status IN ('idle', 'failed', 'cancelled')
    AND S.active_turn_id IS NULL
    AND S.input_wait_until IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM session_turns T
      WHERE T.workspace_id = S.workspace_id AND T.session_id = S.id
        AND (T.status IN ('queued', 'running', 'requires_action', 'recovering', 'waiting_capacity')
          OR (S.archived_at IS NULL AND greatest(T.created_at, T.updated_at) >= P.cutoff)))
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
      SELECT 1 FROM sessions C
      WHERE C.workspace_id = S.workspace_id AND C.parent_session_id = S.id
        AND C.content_archive_state IS NULL
        AND (C.status NOT IN ('idle', 'failed', 'cancelled')
          OR (S.archived_at IS NULL AND (
            C.created_at >= P.cutoff
            OR EXISTS (
              SELECT 1 FROM session_turns CT
              WHERE CT.workspace_id = C.workspace_id AND CT.session_id = C.id
                AND greatest(CT.created_at, CT.updated_at) >= P.cutoff)))))))
    AND NOT EXISTS (
      SELECT 1 FROM scheduled_tasks K
      WHERE K.workspace_id = S.workspace_id AND K.reusable_session_id = S.id
        AND K.deleted_at IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM site_auth_connections A
      WHERE A.workspace_id = S.workspace_id AND A.maintenance_session_id = S.id)
  ORDER BY S.archived_at IS NULL, S.archived_at, S.created_at, S.id
  LIMIT least(greatest(p_limit, 0), 100);
$$;

-- Chats hidden with the old personal archive are archived for real, with
-- their sub-chats, unless something keeps them live on purpose (keep-live, a
-- scheduled task or site sign-in maintenance that runs in them); those simply
-- come back to the list. The earliest member who hid a chat is recorded as
-- the one who archived it. The migration owner is NOSUPERUSER NOBYPASSRLS, so
-- FORCE RLS is lifted for this statement and restored before commit. Those
-- ALTER TABLE locks already exclude every other reader and writer until
-- commit, so no workspace tenancy fence is taken; the fence-checking trigger
-- is disabled for the migration's own write and enabled again before commit.
ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_pins NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions DISABLE TRIGGER session_tenancy_workspace_fence;
WITH hidden AS (
  SELECT DISTINCT ON (P.workspace_id, P.session_id)
    P.workspace_id, P.session_id, P.archived_at, P.subject_id
  FROM session_pins P
  WHERE P.archived AND P.archived_at IS NOT NULL
  ORDER BY P.workspace_id, P.session_id, P.archived_at, P.subject_id
), roots AS (
  SELECT H.*
  FROM hidden H
  JOIN sessions R ON R.workspace_id = H.workspace_id AND R.id = H.session_id
  WHERE R.parent_session_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM sessions T
      WHERE T.workspace_id = H.workspace_id AND T.root_session_id = H.session_id
        AND (T.keep_live
          OR EXISTS (SELECT 1 FROM scheduled_tasks K
            WHERE K.workspace_id = T.workspace_id AND K.reusable_session_id = T.id
              AND K.deleted_at IS NULL)
          OR EXISTS (SELECT 1 FROM site_auth_connections A
            WHERE A.workspace_id = T.workspace_id AND A.maintenance_session_id = T.id)))
)
UPDATE sessions S
SET archived_at = roots.archived_at,
    archive_requested_by = roots.subject_id
FROM roots
WHERE S.workspace_id = roots.workspace_id
  AND S.root_session_id = roots.session_id
  AND S.archived_at IS NULL
  AND S.imported_archive_import_id IS NULL;
ALTER TABLE sessions ENABLE TRIGGER session_tenancy_workspace_fence;
ALTER TABLE session_pins FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
