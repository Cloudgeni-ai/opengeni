-- deployment-mode: rolling
-- Archived chats can be restored (docs/session-storage-lifecycle.md,
-- "Restoring an archived chat"). Until now an archived chat whose content
-- had moved to long-term storage could never become live again: the purged
-- rows only existed in the stored bundle, and the session guard refused to
-- leave the archived state.
--
-- * sessions.content_restore_requested_at records that someone asked to
--   restore a stored chat. The worker re-inserts the purged rows from the
--   verified bundle and returns the chat to live in one transaction, which
--   is the only writer allowed to leave the archived state: it sets the
--   transaction-local opengeni.session_content_restore marker to the
--   session id, and guard_imported_archive_identity accepts exactly that
--   transition (state, manifest and purge time all cleared, keep-live and
--   the imported marker unchanged) only while a restore was requested.
-- * When a stored chat returns to live, its now unreferenced objects are
--   queued for deletion with the same owner routine session deletion uses.
-- * A restored chat counts as active for the idle period, so the idle
--   archiver does not store it again on its next pass.
-- * session_archive_unfinished also returns stored chats whose restore was
--   requested more than five minutes ago (state 'restoring'), so a restore
--   whose workflow was lost is finished by the maintenance pass. The
--   previous release treats such a row like any other stored chat (it
--   finishes an unfinished purge, which the restore re-inserts anyway).
--
-- Rolling: the column is nullable and additive, the guard only gains an
-- exception the previous release never triggers, and both routines keep
-- their signatures, owners and grants.
SET LOCAL lock_timeout = '5s';

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS content_restore_requested_at timestamp with time zone;

-- A new session (a fork or copy) never inherits a restore request.
CREATE OR REPLACE FUNCTION opengeni_private.session_insert_not_archived()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.archived_at := NULL;
  NEW.archive_requested_by := NULL;
  NEW.content_restore_requested_at := NULL;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION opengeni_private.session_insert_not_archived() FROM PUBLIC;

-- The restore transaction is the one writer that may return a stored chat to
-- live. Edited in place (anchored) so the rest of the guard, including its
-- secret-scrub exception and pinned search_path, stays exactly as it is.
DO $restore_guard$
DECLARE
  definition text := pg_get_functiondef('guard_imported_archive_identity()'::regprocedure);
  anchor constant text := $anchor$  IF TG_OP = 'UPDATE' AND OLD.content_archive_state = 'archived' AND
$anchor$;
  replacement constant text := $replacement$  -- 1261: restoring a stored chat (restoreArchivedSessionContent) re-inserts
  -- its purged rows and returns it to live in one transaction, which marks
  -- itself with opengeni.session_content_restore = this session's id.
  IF TG_OP = 'UPDATE' AND OLD.content_archive_state = 'archived'
    AND OLD.content_restore_requested_at IS NOT NULL
    AND current_setting('opengeni.session_content_restore', true) = OLD.id::text
    AND NEW.content_archive_state IS NULL
    AND NEW.content_archive_started_at IS NULL
    AND NEW.content_archived_at IS NULL
    AND NEW.content_archive IS NULL
    AND NEW.content_archive_purged_at IS NULL
    AND NEW.keep_live IS NOT DISTINCT FROM OLD.keep_live
    AND NEW.imported_archive_import_id IS NOT DISTINCT FROM OLD.imported_archive_import_id
    AND (NEW.forked_from_session_id, NEW.parent_session_id)
      IS NOT DISTINCT FROM (OLD.forked_from_session_id, OLD.parent_session_id)
  THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.content_archive_state = 'archived' AND
$replacement$;
BEGIN
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'guard_imported_archive_identity anchor changed';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$restore_guard$;

DROP TRIGGER IF EXISTS sessions_content_restore_object_deletion ON sessions;
CREATE TRIGGER sessions_content_restore_object_deletion AFTER UPDATE OF content_archive ON sessions
  FOR EACH ROW WHEN (OLD.content_archive_state = 'archived' AND NEW.content_archive_state IS NULL)
  EXECUTE FUNCTION opengeni_private.enqueue_session_archive_object_deletion();

-- A chat restored within the idle period is not idle, whatever its turns say.
DO $restored_not_idle$
DECLARE
  definition text := pg_get_functiondef(
    'opengeni_private.session_archive_candidates(bigint, integer, uuid)'::regprocedure);
  anchor constant text := $anchor$    AND S.imported_archive_import_id IS NULL
$anchor$;
  replacement constant text := $replacement$    AND S.imported_archive_import_id IS NULL
    AND (S.archived_at IS NOT NULL OR S.content_restore_requested_at IS NULL
      OR S.content_restore_requested_at < P.cutoff)
$replacement$;
BEGIN
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'session_archive_candidates anchor changed';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$restored_not_idle$;

CREATE OR REPLACE FUNCTION opengeni_private.session_archive_unfinished(p_stale_seconds bigint, p_limit integer) RETURNS TABLE(account_id uuid, workspace_id uuid, session_id uuid, state text)
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT S.account_id, S.workspace_id, S.id,
    CASE WHEN S.content_archive_state = 'archived' AND S.content_restore_requested_at IS NOT NULL
      THEN 'restoring' ELSE S.content_archive_state END
  FROM sessions S
  WHERE (S.content_archive_state = 'archiving'
      AND S.content_archive_started_at
        < clock_timestamp() - make_interval(secs => greatest(p_stale_seconds, 300)))
    OR (S.content_archive_state = 'archived' AND S.content_restore_requested_at IS NULL
      AND S.content_archive_purged_at IS NULL)
    OR (S.content_archive_state = 'archived'
      AND S.content_restore_requested_at < clock_timestamp() - interval '5 minutes')
  ORDER BY S.content_archive_started_at, S.id
  LIMIT least(greatest(p_limit, 0), 100);
$$;
