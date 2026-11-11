-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: changes only cancelled chats that still record an input wait, a few dozen rows at most
-- Cancelling a chat now ends its input wait (the wait an agent set before
-- its turn ended, to be woken at a deadline): a cancelled chat has no turn
-- left to wake, and its workflow never settles the wait. Chats cancelled
-- before kept the wait forever, so they still counted as waiting and the
-- archiver could never store them. Clear those waits.
--
-- Rolling: the previous release reads the same columns and treats a chat
-- without a wait as not waiting; it never sets a wait on a cancelled chat.
-- The migration owner is NOSUPERUSER NOBYPASSRLS, so FORCE RLS is lifted for
-- this statement and restored before commit. Those ALTER TABLE locks exclude
-- every other reader and writer until commit, so no workspace tenancy fence
-- is taken; the fence-checking trigger is disabled for the migration's own
-- write and enabled again before commit.
SET LOCAL lock_timeout = '5s';

ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions DISABLE TRIGGER session_tenancy_workspace_fence;
UPDATE sessions
SET input_wait_turn_id = NULL,
    input_wait_until = NULL,
    input_wait_reason = NULL,
    input_wait_set_at = NULL
WHERE status = 'cancelled'
  AND input_wait_turn_id IS NOT NULL
  AND content_archive_state IS NULL
  AND imported_archive_import_id IS NULL;
ALTER TABLE sessions ENABLE TRIGGER session_tenancy_workspace_fence;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
