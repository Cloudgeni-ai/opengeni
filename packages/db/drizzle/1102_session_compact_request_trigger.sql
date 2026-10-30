-- deployment-mode: rolling
-- Who asked for the pending context compaction. `compact_requested` stays the
-- one durable request; this column only labels it: 'operator' for /compact,
-- 'proactive' when the worker requests an idle checkpoint because the turn that
-- just finished left the session at its automatic compaction threshold. NULL is
-- a request written by an older binary and reads as 'operator'. The label is
-- meaningful only while `compact_requested` is true; nothing reads it otherwise.
-- Older binaries never read or write the column, and the fork routines (0855)
-- start from the complete source row and then clear the request.
SET LOCAL lock_timeout = '5s';

-- Every existing row is NULL, so the bound is added NOT VALID: it holds for
-- every new write without scanning the table under its lock.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS compact_request_trigger text;
ALTER TABLE sessions ADD CONSTRAINT sessions_compact_request_trigger_check
  CHECK (compact_request_trigger IS NULL OR compact_request_trigger IN ('operator', 'proactive'))
  NOT VALID;
