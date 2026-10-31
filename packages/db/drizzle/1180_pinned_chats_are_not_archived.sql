-- deployment-mode: rolling
-- A chat opened from search could be pinned while it was archived. Archiving
-- unpins, but pinning did not restore, so the chat was marked pinned yet never
-- appeared under Pinned, which lists active chats only. Pinning now restores
-- the chat in the same transaction. Repair rows written before that change:
-- archiving clears the pin, so on these rows the pin is always the later
-- action, and the person wants the chat at hand.
-- Rolling: the previous release reads the same shape and already supports a
-- pinned active chat; it only sees these rows move out of the archive.
-- The migration owner is NOSUPERUSER NOBYPASSRLS, so FORCE RLS is lifted for
-- this one statement and restored before commit.
ALTER TABLE "session_pins" NO FORCE ROW LEVEL SECURITY;
UPDATE session_pins
SET archived = false,
    archived_at = NULL,
    archive_version = archive_version + 1
WHERE pinned AND archived;
ALTER TABLE "session_pins" FORCE ROW LEVEL SECURITY;
